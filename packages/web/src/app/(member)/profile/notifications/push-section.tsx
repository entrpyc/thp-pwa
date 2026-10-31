'use client';

import { useEffect, useState } from 'react';
import {
  PUSH_PREFERENCES_PATH,
  type PushCategoryView,
  type PushPreferencePayload,
  type PushPreferenceRequest,
  type PushPreferencesPayload,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import {
  disablePushOnThisDevice,
  enablePushOnThisDevice,
  pushPermission,
  pushSupport,
  rememberedEndpoint,
  type PushPermission,
  type PushSupport,
} from '@/client/push/push-device';
import { SettingsSection } from '../settings/settings-section';
import profile from '../profile.module.css';
import styles from './notifications.module.css';

/**
 * **The push card** ([3.17.13](docs/project/prd.md), [3.17.14](docs/project/prd.md),
 * [3.17.1](docs/project/prd.md)): this device's state, one button that turns the device on or
 * off, and a switch per category.
 *
 * **The button goes both ways.** *Turn on push on this device* is what raises the platform's
 * permission dialog in a browser, and it is raised from that press and nothing else there — not
 * on page load, not when the section opens — because Chrome and Safari ignore a prompt that is
 * not behind a gesture. (The store shells ask at launch instead; `push-shell-listener.tsx`.) Once
 * the device is on, the same place offers *Turn off push on this device*, which unregisters it
 * and remembers the choice so the shell's launch does not turn it back on. Every category is on
 * by default (the operator's choice), so the switches below say what *will* arrive once the
 * device is on; nothing arrives before.
 *
 * **The switches are account-wide; the button is per device.** A switch turned off here is off on
 * every device the member registers, because it is a row on the account; the button registers
 * *this* device and has to be pressed once on each. The status line says which of the two a
 * member is looking at.
 *
 * **Written first, shown after**, as the analytics card does: a press sends the `PUT`, and only
 * the answer — the whole list, as the server now holds it — re-renders the switches. A failed
 * write leaves the switch where it was and says so.
 *
 * **A switch is a button with `role="switch"`.** The codebase has no toggle control; this is the
 * first setting that is genuinely a set of on/off facts rather than one action, and a row of
 * four *Turn X off* buttons would be four sentences where four switches read at a glance. The
 * role and `aria-checked` are what a screen reader needs; the look is the one accent, as the
 * bell's badge is.
 */

const LOAD_FAILED = 'Could not load your notification settings. Reload the page to try again.';
const WRITE_FAILED = 'Could not save that. Nothing has changed — try again in a moment.';

type DeviceState =
  | { readonly kind: 'checking' }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'no-browser-key' }
  | { readonly kind: 'denied' }
  | { readonly kind: 'off' }
  | { readonly kind: 'on' }
  | { readonly kind: 'enabling' }
  | { readonly kind: 'disabling' };

function deviceStateFor(
  support: PushSupport,
  permission: PushPermission,
  registered: boolean,
  webKey: string | null,
): DeviceState {
  if (support === 'unsupported') return { kind: 'unsupported' };
  if (support === 'web' && webKey === null) return { kind: 'no-browser-key' };
  if (permission === 'denied') return { kind: 'denied' };
  if (permission === 'granted' && registered) return { kind: 'on' };
  return { kind: 'off' };
}

export function PushSection() {
  const [payload, setPayload] = useState<PushPreferencesPayload | null>(null);
  const [device, setDevice] = useState<DeviceState>({ kind: 'checking' });
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<PushPreferencesPayload>(PUSH_PREFERENCES_PATH, { credentials: 'include' })
      .then(async (loaded) => {
        const permission = await pushPermission();
        if (cancelled) return;
        setPayload(loaded);
        setDevice(
          deviceStateFor(
            pushSupport(),
            permission,
            rememberedEndpoint() !== null,
            loaded.webPush?.publicKey ?? null,
          ),
        );
      })
      .catch(() => {
        if (!cancelled) setFailure(LOAD_FAILED);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function enable(): Promise<void> {
    if (device.kind !== 'off' || payload === null) return;
    setDevice({ kind: 'enabling' });
    setFailure(null);
    setDone(null);
    const result = await enablePushOnThisDevice(payload.webPush?.publicKey ?? null);
    if (result.ok) {
      setDevice({ kind: 'on' });
      setDone('Push is on for this device.');
      return;
    }
    if (result.reason === 'denied') {
      setDevice({ kind: 'denied' });
      return;
    }
    setDevice(result.reason === 'unsupported' ? { kind: 'unsupported' } : { kind: 'off' });
    setFailure('Could not turn on push on this device. Try again in a moment.');
  }

  async function disable(): Promise<void> {
    if (device.kind !== 'on') return;
    setDevice({ kind: 'disabling' });
    setFailure(null);
    setDone(null);
    await disablePushOnThisDevice({ deliberate: true });
    setDevice({ kind: 'off' });
    setDone('Push is off for this device.');
  }

  async function toggle(entry: PushCategoryView): Promise<void> {
    if (busy !== null) return;
    setBusy(entry.category);
    setFailure(null);
    setDone(null);
    try {
      const body: PushPreferenceRequest = { category: entry.category, pushEnabled: !entry.pushEnabled };
      const saved = await apiFetch<PushPreferencePayload>(PUSH_PREFERENCES_PATH, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      setPayload(saved);
    } catch (caught) {
      setFailure(caught instanceof ApiClientError ? caught.message : WRITE_FAILED);
    } finally {
      setBusy(null);
    }
  }

  return (
    <SettingsSection
      title="Push notifications"
      lead="Push reaches your phone or computer when the app is closed. Turn it on for each device you use; the switches below apply to every device."
    >
      <p className={profile.done} role="status">
        {describeDevice(device)}
      </p>

      {device.kind === 'off' || device.kind === 'enabling' ? (
        <div className={profile.actions}>
          <button
            className={profile.primary}
            type="button"
            onClick={() => void enable()}
            disabled={device.kind === 'enabling' || payload === null}
          >
            {device.kind === 'enabling' ? 'Turning on…' : 'Turn on push on this device'}
          </button>
        </div>
      ) : null}
      {device.kind === 'on' || device.kind === 'disabling' ? (
        <div className={profile.actions}>
          <button
            className={profile.secondary}
            type="button"
            onClick={() => void disable()}
            disabled={device.kind === 'disabling'}
          >
            {device.kind === 'disabling' ? 'Turning off…' : 'Turn off push on this device'}
          </button>
        </div>
      ) : null}

      {payload === null && failure === null ? (
        <p className={profile.quiet}>Loading…</p>
      ) : null}

      {payload !== null ? (
        <ul className={styles.switchList} aria-label="Notification categories">
          {payload.categories.map((entry) => (
            <li className={styles.switchRow} key={entry.category}>
              <div className={styles.switchText}>
                <p className={styles.switchLabel} id={`push-${entry.category}`}>
                  {entry.label}
                </p>
                <p className={profile.quiet}>{entry.description}</p>
              </div>
              <button
                className={styles.switch}
                type="button"
                role="switch"
                aria-checked={entry.pushEnabled}
                aria-labelledby={`push-${entry.category}`}
                disabled={busy !== null}
                onClick={() => void toggle(entry)}
              >
                <span className={styles.switchKnob} aria-hidden="true" />
                <span className={styles.switchState}>{entry.pushEnabled ? 'On' : 'Off'}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {done === null ? null : (
        <p className={profile.done} role="status">
          {done}
        </p>
      )}
      {failure === null ? null : <p className={profile.failure}>{failure}</p>}
    </SettingsSection>
  );
}

function describeDevice(device: DeviceState): string {
  switch (device.kind) {
    case 'checking':
      return 'Checking this device…';
    case 'unsupported':
      return 'This browser cannot receive push. On an iPhone, add the app to your home screen from the Share menu and open it from there; on a computer, use a current browser.';
    case 'no-browser-key':
      return 'Push is not set up for browsers on this deployment yet. The store app receives push.';
    case 'denied':
      return 'Push is blocked for this app in your device settings. Allow notifications there, then come back.';
    case 'off':
    case 'enabling':
      return 'Push is off for this device.';
    case 'on':
    case 'disabling':
      return 'Push is on for this device.';
  }
}
