import type { StoredObject } from '@thp/media';
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL, describeBytes } from '@thp/shared';

/**
 * **The original is checked again before the worker reads it.**
 *
 * Finalising an upload checks the object's size once, on the API side — but the presigned `PUT`
 * that put it there binds only the content type and lives for an hour, and the key never changes
 * after finalise. An admin (or a stolen admin session) can therefore finalise a small file and
 * then `PUT` a multi-gigabyte one over the same key, and every later step that streams the
 * original to disk or hands it to a provider would take the bigger one on trust: worker disk and
 * memory exhaustion, and hours of ASR billing (security audit 2026-10-28, finding 9).
 *
 * So every handler that is about to read the original — directly, or through a signed URL a
 * provider fetches — asks the store what is there *now* and refuses anything over the same
 * ceiling the upload path enforces. The ceiling is the one constant, so the two cannot disagree.
 */
export function checkSourceObject(key: string, stored: StoredObject): void {
  if (stored.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `the object at key "${key}" is ${describeBytes(stored.size)}, over the ${MAX_UPLOAD_LABEL} ` +
        'upload limit — it was replaced after the upload was finalised, and this step will not read it',
    );
  }
}
