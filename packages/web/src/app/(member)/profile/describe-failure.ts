import { ApiClientError } from '@/client/api-client';

/**
 * The API's own sentence when it had one; the screen's fallback when it did not.
 *
 * Shared by the picture card and the name card — the two writes the identity page makes — because
 * rule 2 of the profile screen is one rule, not one per card: an over-long name and an upload that
 * did not finish are different problems, and each is answered in the route's words.
 */
export function describeFailure(caught: unknown, fallback: string): string {
  return caught instanceof ApiClientError ? caught.message : fallback;
}
