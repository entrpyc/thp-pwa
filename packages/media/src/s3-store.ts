import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { readMediaSettings } from './env';
import type { MediaStore, StoredObject } from './store';

/**
 * **The one file in the repository permitted to import the S3 SDK** — tools/media-boundary.ts
 * fails the build if a second one appears, exactly as `server/mail/transports.ts` is the one file
 * permitted to import a mail library.
 *
 * It speaks plain S3 and names no vendor. Production is Cloudflare R2 and development is the MinIO
 * container in docker-compose.yml; neither is mentioned here, and swapping between them is the
 * five `MEDIA_` values in `.env`.
 *
 * `forcePathStyle` is on because MinIO has no per-bucket DNS and R2 accepts path style unchanged.
 * A virtual-hosted-style client would work against one and not the other, and the difference would
 * only show up the first time somebody ran the suite.
 */
export function buildMediaStore(): MediaStore {
  const settings = readMediaSettings();

  const client = new S3Client({
    region: settings.region,
    endpoint: settings.endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: settings.accessKeyId,
      secretAccessKey: settings.secretAccessKey,
    },
  });

  return {
    name: 's3',

    async presignPut({ key, contentType, expiresInSeconds }) {
      return getSignedUrl(
        client,
        new PutObjectCommand({ Bucket: settings.bucket, Key: key, ContentType: contentType }),
        {
          expiresIn: expiresInSeconds,
          // **The content type has to be a signed header, not merely a parameter.** Without this
          // the signature covers only the host, and a browser is free to `PUT` anything it likes
          // under a grant issued for an mp3 — which would make "bound to the declared content type"
          // a sentence rather than a property. With it, a mismatched header fails the signature at
          // the store before a byte of the body is read.
          signableHeaders: new Set(['content-type']),
        },
      );
    },

    async presignGet({ key, expiresInSeconds }) {
      // No signable-headers set, unlike the `PUT`: a reader sends no headers worth binding, and the
      // signature already covers the bucket, the key and the expiry — which is the whole of what a
      // read grant is allowed to be.
      return getSignedUrl(client, new GetObjectCommand({ Bucket: settings.bucket, Key: key }), {
        expiresIn: expiresInSeconds,
      });
    },

    async head(key: string): Promise<StoredObject | null> {
      try {
        const response = await client.send(
          new HeadObjectCommand({ Bucket: settings.bucket, Key: key }),
        );
        return {
          size: response.ContentLength ?? 0,
          contentType: response.ContentType ?? '',
        };
      } catch (cause) {
        // "Nothing is there" is an answer, not a failure — finalising an unused key is a case the
        // caller refuses in its own words. Anything else is a real fault and keeps travelling.
        if (isNotFound(cause)) return null;
        throw cause;
      }
    },
  };
}

/**
 * A `HEAD` against a missing key answers `404` with no body, so the SDK reports it as `NotFound`
 * rather than as `NoSuchKey`. Both names are matched, plus the status, because which one arrives
 * depends on the store rather than on us.
 */
function isNotFound(cause: unknown): boolean {
  if (typeof cause !== 'object' || cause === null) return false;
  const { name, $metadata } = cause as {
    name?: unknown;
    $metadata?: { httpStatusCode?: number };
  };
  if (name === 'NotFound' || name === 'NoSuchKey') return true;
  return $metadata?.httpStatusCode === 404;
}
