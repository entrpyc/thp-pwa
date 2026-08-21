import { CreateBucketCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';

/**
 * The suite's object store.
 *
 * The integration tests need a **real** S3-compatible store, for the same reason the migration
 * tests need a real Postgres: presigning, the content-type binding, expiry, the CORS preflight and
 * — above all — "an object is not readable without a signature" are properties of a store, and
 * asserting them against a fake proves nothing about the one this product runs on. That store is
 * the MinIO container in docker-compose.yml.
 *
 * **It is deliberately not read from `.env`.** Every other connection the suite makes is: the
 * database URL comes from the developer's environment, and the suite carves a throwaway database
 * out of it. The media store cannot work that way, because `.env` is where a deployment's real
 * bucket credentials live — and a suite that read them would create a bucket in production and
 * upload two hundred megabytes of test objects into a store **with no delete path**. A throwaway
 * database is dropped afterwards; an object written to the wrong bucket is there for good.
 *
 * So the values below are the harness's own, exactly as `MAIL_FROM` and the capture transport are:
 * they are the literals in docker-compose.yml, not secrets, and changing the container's port or
 * credentials means changing them here too. That is the price of the suite being unable to reach
 * anything but the container.
 *
 * This file imports the S3 SDK directly and is allowed to: tools/media-boundary.ts covers
 * application source, and creating a bucket is not something the application ever does.
 */

/** The container in docker-compose.yml, and nothing else. */
export const TEST_MEDIA = {
  MEDIA_ENDPOINT: 'http://127.0.0.1:9000',
  MEDIA_REGION: 'auto',
  /** The suite's own bucket, never the one a deployment or a developer's `.env` names. */
  MEDIA_BUCKET: 'thp-test-media',
  MEDIA_ACCESS_KEY_ID: 'thp',
  MEDIA_SECRET_ACCESS_KEY: 'thp-secret-not-a-real-key',
} as const;

export type MediaEnvironment = typeof TEST_MEDIA;

/**
 * Create the suite's bucket if it is not already there. Idempotent across runs.
 *
 * Not dropped when the run ends, unlike the throwaway database: emptying it would mean deleting
 * objects, and this repository has no delete path against a bucket anywhere — not even in its test
 * harness. Every key is a uuid, so runs cannot collide, and the container's volume is local and
 * disposable.
 */
export async function ensureTestBucket(settings: MediaEnvironment = TEST_MEDIA): Promise<void> {
  const client = new S3Client({
    region: settings.MEDIA_REGION,
    endpoint: settings.MEDIA_ENDPOINT,
    forcePathStyle: true,
    credentials: {
      accessKeyId: settings.MEDIA_ACCESS_KEY_ID,
      secretAccessKey: settings.MEDIA_SECRET_ACCESS_KEY,
    },
  });

  try {
    try {
      await client.send(new HeadBucketCommand({ Bucket: settings.MEDIA_BUCKET }));
      return;
    } catch {
      // Not there yet, or not reachable — the create below decides which.
    }
    await client.send(new CreateBucketCommand({ Bucket: settings.MEDIA_BUCKET }));
  } catch (cause) {
    const name = typeof cause === 'object' && cause !== null ? (cause as Error).name : '';
    // Two runs starting at once, or a bucket that appeared between the head and the create.
    if (name === 'BucketAlreadyOwnedByYou' || name === 'BucketAlreadyExists') return;
    throw new Error(
      `Could not reach the object store at ${settings.MEDIA_ENDPOINT}. Start it with ` +
        '`docker compose up -d minio` (see README.md, "Media store"). The suite talks only to that ' +
        'container and never to whatever `.env` points at — a deployment bucket has no delete path, ' +
        'so a test run must not be able to write into one.',
      { cause },
    );
  } finally {
    client.destroy();
  }
}
