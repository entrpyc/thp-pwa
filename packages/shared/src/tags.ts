/**
 * **Tags — the shared taxonomy over recordings and series** ([4.7](docs/project/prd.md)).
 *
 * A tag is a name and nothing else. It is applied by hand: nothing in the pipeline suggests one,
 * and no review item ever holds one ([4.17.1](docs/project/prd.md)) — which is the whole reason
 * this file has no provenance field, no `suggested` state and no model version on it.
 *
 * **One taxonomy, two kinds of thing it is applied to.** A tag used on a recording is the same tag
 * used on a series, so there is one collection at `/tags` and two places it is applied from — a
 * recording's and a series' own `…/tags` sub-resource, declared beside the resource each one
 * changes (`recordings.ts`, `series.ts`). This file deliberately imports neither: both of them read
 * {@link TagRef} from here, and a cycle is what one import back would make.
 *
 * **Names are lowercase, and that is the identity.** `Grace` and `grace` are one tag, not two, and
 * the way that is made true is that no other spelling ever reaches a row: {@link normaliseTagName}
 * is applied on the server before any write and on the client before any request, and the
 * database refuses a second row with the same name. Whitespace is trimmed and collapsed for the
 * same reason — two spaces are not a second tag.
 */

/** The tag collection, relative to the `/api/v1` prefix. */
export const TAGS_PATH = '/tags';

/** One tag, under the API prefix — where it is renamed and where it is deleted. */
export function tagPath(tagId: string): string {
  return `${TAGS_PATH}/${tagId}`;
}

/** The console's sixth panel, on the web origin rather than under the API prefix. */
export const ADMIN_TAGS_PAGE_PATH = '/admin/tags';

/**
 * The most a tag name can be, in characters, after normalisation.
 *
 * Short on purpose: a tag is a label a member scans on a row, not a sentence. Enforced by the
 * server before a write and by the database beside it, so the number lives here once and both
 * read it.
 */
export const MAX_TAG_LENGTH = 40;

/**
 * **The one spelling a tag name has.** Trimmed, inner whitespace collapsed to one space, lowercase.
 *
 * Applied everywhere a name enters — the create form, the rename form, the type-to-add field on a
 * row — so the server and the client agree about which names are the same name before either has
 * asked the database. An empty result means the input was nothing but whitespace, and every caller
 * treats that as "no tag" rather than as a tag called nothing.
 */
export function normaliseTagName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** A tag as it rides on a recording or a series: the id, and the name a surface prints. */
export interface TagRef {
  readonly id: string;
  readonly name: string;
}

/**
 * A tag as the console's Tags panel reads it — the ref plus how many of each kind of thing it is
 * on. Both counts are **over every row**, published or not: this is an operator's view of the
 * taxonomy, and the count that matters when deciding whether to delete a tag is the count of
 * things the deletion touches.
 */
export interface TagView extends TagRef {
  readonly recordingCount: number;
  readonly seriesCount: number;
}

/** Payload of `GET /api/v1/tags`. Every tag, alphabetically. */
export interface TagListPayload {
  readonly tags: readonly TagView[];
}

/** Payload of `POST /api/v1/tags` and `PATCH /api/v1/tags/{id}`. */
export interface TagPayload {
  readonly tag: TagView;
}

/** Body of `POST /api/v1/tags`. Normalised before it is compared with anything. */
export interface CreateTagRequest {
  readonly name: string;
}

/** Body of `PATCH /api/v1/tags/{id}`. The new name, normalised the same way. */
export interface RenameTagRequest {
  readonly name: string;
}

/**
 * Payload of `DELETE /api/v1/tags/{id}` — what was removed, and from how many things.
 *
 * The counts are read in the same transaction that deletes the rows, so the console can say
 * "removed from 3 recordings and 1 series" as a fact rather than as the count it happened to be
 * showing before the press.
 */
export interface DeleteTagPayload {
  readonly id: string;
  readonly name: string;
  readonly recordingCount: number;
  readonly seriesCount: number;
}

/**
 * Body of `PUT /api/v1/recordings/{id}/tags` and `PUT /api/v1/series/{id}/tags` — **the whole set,
 * by name**.
 *
 * Names rather than ids, because that is what type-to-add produces: an admin types `grace` and
 * the request should not have to first ask whether `grace` exists. A name that is not yet a tag
 * becomes one in the same request; a name that is becomes an application of the tag it already
 * was. The whole set rather than an add-or-remove pair, so the row's chips and the database agree
 * after every request with no sequence to replay.
 */
export interface SetTagsRequest {
  readonly names: readonly string[];
}

/** Payload of both `PUT …/tags` routes: the tags now on the item, alphabetically. */
export interface TagsPayload {
  readonly tags: readonly TagRef[];
}
