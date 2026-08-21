/**
 * The negative control for tools/media-boundary.ts. A second door to the bucket: a module that is
 * not the adapter and reaches for the S3 SDK anyway — and, being outside the port, one that could
 * delete an original.
 */
import { S3Client } from '@aws-sdk/client-s3';

export const leaked = new S3Client({ region: 'auto' });
