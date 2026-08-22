/**
 * Generation configuration, read here and nowhere else — the same discipline `asr/env.ts` applies
 * to the transcription block, `packages/db/src/env.ts` to `DATABASE_URL` and the web app's
 * `mail/env.ts` to SMTP. A missing setting should fail with one sentence naming the variable, not
 * as an authorisation error three frames deep inside a provider call.
 *
 * **No vendor is compiled in**, and **no key has a default.** A default API key is not a thing; a
 * default *provider* is, and it is the real one, exactly as `ASR_PROVIDER` defaults to `deepgram`.
 */

export type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * Which generator to build.
 *
 * - `minimax` — the real one. The only one a deployment should ever name.
 * - `fake` — reads a fixed script off disk and returns it. What the whole suite runs against, which
 *   is what makes "no test reaches a provider" a property of the configuration rather than of a
 *   mock somebody remembered to install. The same shape as `ASR_PROVIDER=fake` and
 *   `MAIL_TRANSPORT=capture`.
 */
export const GENERATE_PROVIDERS = ['minimax', 'fake'] as const;

export type GenerateProviderName = (typeof GENERATE_PROVIDERS)[number];

export function readGenerateProvider(env: EnvSource = process.env): GenerateProviderName {
  const configured = (env['GENERATE_PROVIDER'] ?? 'minimax').trim().toLowerCase();
  if ((GENERATE_PROVIDERS as readonly string[]).includes(configured)) {
    return configured as GenerateProviderName;
  }
  throw new Error(
    `GENERATE_PROVIDER is "${configured}". It must be one of ${GENERATE_PROVIDERS.join(', ')} — see .env.example.`,
  );
}

/** Every variable this module reads, named in one place so a reader can find the block. */
export const GENERATE_VARIABLES = [
  'GENERATE_PROVIDER',
  'GENERATE_API_KEY',
  'GENERATE_FAKE_SCRIPT',
] as const;

function require_(env: EnvSource, name: string, because: string): string {
  const value = env[name];
  if (!value || value.trim() === '') {
    throw new Error(`${name} is not set, and ${because} See .env.example.`);
  }
  return value.trim();
}

/** The provider key. Required whenever the real adapter is in use, and never defaulted. */
export function readGenerateApiKey(env: EnvSource = process.env): string {
  return require_(env, 'GENERATE_API_KEY', 'GENERATE_PROVIDER is "minimax".');
}

/** Where the fake reads its script. Only read when `GENERATE_PROVIDER=fake`. */
export function readGenerateFakeScriptPath(env: EnvSource = process.env): string {
  return require_(env, 'GENERATE_FAKE_SCRIPT', 'GENERATE_PROVIDER is "fake".');
}
