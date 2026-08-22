/**
 * ASR configuration, read here and nowhere else — the same discipline `packages/db/src/env.ts`
 * applies to `DATABASE_URL`, `@thp/media`'s `env.ts` to the bucket and the web app's `mail/env.ts`
 * to SMTP, and for the same reason: a missing setting should fail with one sentence naming the
 * variable, not as an authorisation error three frames deep inside a provider call.
 *
 * **No vendor is compiled in**, and **no key has a default.** A default API key is not a thing;
 * a default *provider* is, and it is the real one, exactly as `MAIL_TRANSPORT` defaults to `smtp`.
 */

import { isExternalMocked } from '@thp/shared/mock';

export type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * Which transcriber to build.
 *
 * - `deepgram` — the real one. The only one a deployment should ever name.
 * - `fake` — reads a fixed script off disk and returns it. What the whole suite runs against, which
 *   is what makes "no test reaches a provider" a property of the configuration rather than of a
 *   mock somebody remembered to install. The same shape as `MAIL_TRANSPORT=capture`.
 */
export const ASR_PROVIDERS = ['deepgram', 'fake'] as const;

export type AsrProviderName = (typeof ASR_PROVIDERS)[number];

/**
 * `THP_MOCK_EXTERNAL` is read first and **wins over an explicitly named provider** — see
 * `@thp/shared/mock` for why the switch can have no exceptions and still mean anything.
 */
export function readAsrProvider(env: EnvSource = process.env): AsrProviderName {
  if (isExternalMocked(env)) return 'fake';
  const configured = (env['ASR_PROVIDER'] ?? 'deepgram').trim().toLowerCase();
  if ((ASR_PROVIDERS as readonly string[]).includes(configured)) {
    return configured as AsrProviderName;
  }
  throw new Error(
    `ASR_PROVIDER is "${configured}". It must be one of ${ASR_PROVIDERS.join(', ')} — see .env.example.`,
  );
}

/** Every variable this module reads, named in one place so a reader can find the block. */
export const ASR_VARIABLES = ['ASR_PROVIDER', 'ASR_API_KEY', 'ASR_FAKE_SCRIPT'] as const;

function require_(env: EnvSource, name: string, because: string): string {
  const value = env[name];
  if (!value || value.trim() === '') {
    throw new Error(`${name} is not set, and ${because} See .env.example.`);
  }
  return value.trim();
}

/** The provider key. Required whenever the real adapter is in use, and never defaulted. */
export function readAsrApiKey(env: EnvSource = process.env): string {
  return require_(env, 'ASR_API_KEY', 'ASR_PROVIDER is "deepgram".');
}

/** Where the fake reads its script. Only read when `ASR_PROVIDER=fake`. */
export function readFakeScriptPath(env: EnvSource = process.env): string {
  return require_(env, 'ASR_FAKE_SCRIPT', 'ASR_PROVIDER is "fake".');
}
