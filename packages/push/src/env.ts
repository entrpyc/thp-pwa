import { isExternalMocked } from '@thp/shared/mock';

/**
 * Push configuration, read here and nowhere else — the discipline `packages/db/src/env.ts` and
 * the mail module apply, for the same reason: a missing setting fails with one sentence naming the
 * variable rather than as a provider's 401 three frames deep.
 *
 * **Three channels, each optional.** Web Push wants a VAPID key pair; the iOS store build wants an
 * APNs token key; the Android store build wants a Firebase service account. A deployment that has
 * set none of them runs: every subscription on an unconfigured channel is skipped and logged
 * once, and nothing is refused. That is deliberate — the web app and the worker must not fail to
 * boot over a channel the store builds are not yet shipping on — and it is why each reader below
 * answers `null` for "not set" and throws only for "set wrongly".
 *
 * **The transport is one switch.** `real` sends through whichever channels are configured;
 * `capture` appends every would-be send to a JSON-lines file — what the suite reads and what a
 * developer tails; `off` sends nothing and says nothing. `THP_MOCK_EXTERNAL` wins and resolves to
 * `capture`, exactly as it does for mail.
 */

export type EnvSource = Readonly<Record<string, string | undefined>>;

export const PUSH_TRANSPORTS = ['real', 'capture', 'off'] as const;

export type PushTransportName = (typeof PUSH_TRANSPORTS)[number];

export function readPushTransportName(env: EnvSource = process.env): PushTransportName {
  if (isExternalMocked(env)) return 'capture';
  const configured = (env['PUSH_TRANSPORT'] ?? 'real').trim().toLowerCase();
  if ((PUSH_TRANSPORTS as readonly string[]).includes(configured)) {
    return configured as PushTransportName;
  }
  throw new Error(
    `PUSH_TRANSPORT is "${configured}". It must be one of ${PUSH_TRANSPORTS.join(', ')} — see .env.example.`,
  );
}

/** Where a captured push is written. Under `.tmp/`, which is gitignored. */
export function readPushCapturePath(env: EnvSource = process.env): string {
  const value = env['PUSH_CAPTURE_PATH'];
  if (!value || value.trim() === '') {
    throw new Error(
      'PUSH_CAPTURE_PATH is not set, and the push transport is "capture". Point it at a file under ' +
        '.tmp/ — see .env.example.',
    );
  }
  return value.trim();
}

// =================================================================================================
// Web Push
// =================================================================================================

export interface VapidSettings {
  readonly publicKey: string;
  readonly privateKey: string;
  /** A `mailto:` or `https:` URL the push service can contact about abuse. */
  readonly subject: string;
}

/**
 * The VAPID pair, or `null` when neither half is set. Half a pair is a mistake and is refused:
 * a public key with no private key would let browsers subscribe to a sender that can never sign.
 */
export function readVapidSettings(env: EnvSource = process.env): VapidSettings | null {
  const publicKey = env['VAPID_PUBLIC_KEY']?.trim() ?? '';
  const privateKey = env['VAPID_PRIVATE_KEY']?.trim() ?? '';
  if (publicKey === '' && privateKey === '') return null;
  if (publicKey === '' || privateKey === '') {
    throw new Error(
      'VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be set together. Generate a pair with ' +
        '`npx web-push generate-vapid-keys` — see .env.example.',
    );
  }
  const subject = env['VAPID_SUBJECT']?.trim() ?? '';
  if (!/^(mailto:|https:)/.test(subject)) {
    throw new Error(
      'VAPID_SUBJECT must be a mailto: address or an https: URL the push services can reach you at.',
    );
  }
  return { publicKey, privateKey, subject };
}

// =================================================================================================
// APNs
// =================================================================================================

export interface ApnsSettings {
  readonly keyId: string;
  readonly teamId: string;
  /** The PEM contents of the `.p8` key. */
  readonly privateKey: string;
  /** The app's bundle id — the `apns-topic` of every request. */
  readonly bundleId: string;
  readonly environment: 'production' | 'sandbox';
}

/** The shell's bundle id, which is what `apns-topic` names unless a deployment says otherwise. */
export const DEFAULT_APNS_BUNDLE_ID = 'com.indepthwebsolutions.teachinghub';

/**
 * The APNs token-key settings, or `null` when `APNS_KEY_ID` is unset. The key itself is the PEM
 * text — the contents of the `.p8` file, newlines and all — so a deployment holds it in the
 * same `.env` as every other secret rather than as a file beside it. `APNS_ENVIRONMENT` is
 * `production` unless a build installed from Xcode is being tested, which registers with the
 * sandbox and is refused by the production host.
 */
export function readApnsSettings(env: EnvSource = process.env): ApnsSettings | null {
  const keyId = env['APNS_KEY_ID']?.trim() ?? '';
  if (keyId === '') return null;
  const teamId = env['APNS_TEAM_ID']?.trim() ?? '';
  const privateKey = (env['APNS_PRIVATE_KEY'] ?? '').replace(/\\n/g, '\n').trim();
  if (teamId === '' || privateKey === '') {
    throw new Error(
      'APNS_KEY_ID is set, so APNS_TEAM_ID and APNS_PRIVATE_KEY (the .p8 contents) must be too — ' +
        'see .env.example.',
    );
  }
  if (!privateKey.includes('BEGIN PRIVATE KEY')) {
    throw new Error('APNS_PRIVATE_KEY does not look like the PEM contents of a .p8 key.');
  }
  const environment = (env['APNS_ENVIRONMENT'] ?? 'production').trim().toLowerCase();
  if (environment !== 'production' && environment !== 'sandbox') {
    throw new Error(`APNS_ENVIRONMENT is "${environment}". It must be production or sandbox.`);
  }
  return {
    keyId,
    teamId,
    privateKey,
    bundleId: env['APNS_BUNDLE_ID']?.trim() || DEFAULT_APNS_BUNDLE_ID,
    environment,
  };
}

// =================================================================================================
// FCM
// =================================================================================================

export interface FcmSettings {
  readonly projectId: string;
  readonly clientEmail: string;
  /** The service account's RSA private key, PEM. */
  readonly privateKey: string;
  readonly tokenUri: string;
}

/**
 * The Firebase service account, or `null` when `FCM_SERVICE_ACCOUNT` is unset. The value is the
 * service-account JSON as Firebase downloads it, held in `.env` as one line, for the reason the
 * APNs key is: one file of secrets, one mode, one backup.
 */
export function readFcmSettings(env: EnvSource = process.env): FcmSettings | null {
  const raw = env['FCM_SERVICE_ACCOUNT']?.trim() ?? '';
  if (raw === '') return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error('FCM_SERVICE_ACCOUNT is not valid JSON. Paste the service-account file as one line.');
  }
  const projectId = parsed['project_id'];
  const clientEmail = parsed['client_email'];
  const privateKey = parsed['private_key'];
  if (
    typeof projectId !== 'string' ||
    typeof clientEmail !== 'string' ||
    typeof privateKey !== 'string'
  ) {
    throw new Error(
      'FCM_SERVICE_ACCOUNT is missing project_id, client_email or private_key — it should be the ' +
        'JSON Firebase downloads for a service account.',
    );
  }
  const tokenUri = typeof parsed['token_uri'] === 'string' ? parsed['token_uri'] : '';
  return {
    projectId,
    clientEmail,
    privateKey,
    tokenUri: tokenUri || 'https://oauth2.googleapis.com/token',
  };
}
