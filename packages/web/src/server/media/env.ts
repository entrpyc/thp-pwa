/**
 * Media store configuration, read here and nowhere else — the same discipline
 * `packages/db/src/env.ts` applies to `DATABASE_URL` and `server/mail/env.ts` applies to SMTP, and
 * for the same reason: a missing setting should fail with one sentence naming the variable, not as
 * a signing error three frames deep.
 *
 * **No vendor is compiled in.** The adapter speaks plain S3, which every candidate speaks, so
 * moving between Cloudflare R2, Backblaze B2, AWS S3 and the MinIO container development runs
 * against is these five values rather than a change of code. `.env.example` ships the container's,
 * because that is what a clean checkout has; nothing in the source knows what a deployment points
 * at.
 *
 * **There are no defaults.** Not for the region, not for the endpoint, and least of all for the
 * bucket: a default bucket name is a default place to put somebody's teaching, and the failure mode
 * of getting it wrong is silent.
 */

export type EnvSource = Readonly<Record<string, string | undefined>>;

export interface MediaSettings {
  /** The S3 API endpoint. R2's account endpoint, or the MinIO container's. */
  readonly endpoint: string;
  /** R2 wants `auto`; a real S3 region works unchanged. */
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

const MEDIA_VARIABLES = [
  'MEDIA_ENDPOINT',
  'MEDIA_REGION',
  'MEDIA_BUCKET',
  'MEDIA_ACCESS_KEY_ID',
  'MEDIA_SECRET_ACCESS_KEY',
] as const;

function require_(env: EnvSource, name: string): string {
  const value = env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `${name} is not set. The media store has no defaults — copy the MEDIA_ block from ` +
        '.env.example and point it at your bucket (see README.md, "Media store").',
    );
  }
  return value.trim();
}

export function readMediaSettings(env: EnvSource = process.env): MediaSettings {
  // Every variable is named before any is read, so a deployment missing three of them is told about
  // the first one and finds the other two in the same block rather than one restart at a time.
  const [endpoint, region, bucket, accessKeyId, secretAccessKey] = MEDIA_VARIABLES.map((name) =>
    require_(env, name),
  ) as [string, string, string, string, string];

  return { endpoint, region, bucket, accessKeyId, secretAccessKey };
}

export { MEDIA_VARIABLES };
