/**
 * **Release notes — the document a post is, and the wire contract around it.**
 *
 * A release note is a post an admin writes to say what is new: a title and a rich-text body that
 * can carry pictures (GIFs included) and YouTube videos. Members read the list at `/release-notes`
 * and open one post at `/release-notes/{id}`; a new-feature notification lands on one.
 *
 * **The body is a document, not markup.** What is stored and what travels is a tree of a fixed set
 * of node types — the shape the editor produces — and never HTML. {@link parseReleaseNoteDoc} is
 * the one reading of that tree: anything it does not recognise is refused rather than dropped, so
 * the server cannot store a node the reader has no way to paint, and the reader never has to
 * inject a string as markup.
 *
 * **A picture is a key at rest and a URL in flight.** The store is private, so the stored document
 * names each picture by its upload key; a read signs the keys into short-lived URLs. The three
 * document types below differ only in what an image node carries.
 */

// =================================================================================================
// The document
// =================================================================================================

export const RELEASE_NOTE_PLAIN_MARKS = ['bold', 'italic', 'underline', 'strike', 'code'] as const;

export type ReleaseNotePlainMark = (typeof RELEASE_NOTE_PLAIN_MARKS)[number];

export type ReleaseNoteMark =
  | { readonly type: ReleaseNotePlainMark }
  | { readonly type: 'link'; readonly attrs: { readonly href: string } };

export interface ReleaseNoteText {
  readonly type: 'text';
  readonly text: string;
  readonly marks?: readonly ReleaseNoteMark[];
}

export type ReleaseNoteInline = ReleaseNoteText | { readonly type: 'hardBreak' };

/** What an image node carries at rest: the upload key and the words that describe the picture. */
export interface StoredImageAttrs {
  readonly key: string;
  readonly alt: string | null;
}

/** What a member's read carries: a signed URL and never the key. */
export interface ViewImageAttrs {
  readonly src: string;
  readonly alt: string | null;
}

/** What the editor is handed: the URL to paint and the key to send back. */
export interface EditorImageAttrs extends StoredImageAttrs {
  readonly src: string;
}

export const RELEASE_NOTE_HEADING_LEVELS = [2, 3] as const;

export type ReleaseNoteHeadingLevel = (typeof RELEASE_NOTE_HEADING_LEVELS)[number];

export type ReleaseNoteBlock<Image> =
  | { readonly type: 'paragraph'; readonly content?: readonly ReleaseNoteInline[] }
  | {
      readonly type: 'heading';
      readonly attrs: { readonly level: ReleaseNoteHeadingLevel };
      readonly content?: readonly ReleaseNoteInline[];
    }
  | { readonly type: 'bulletList'; readonly content: readonly ReleaseNoteListItem<Image>[] }
  | { readonly type: 'orderedList'; readonly content: readonly ReleaseNoteListItem<Image>[] }
  | { readonly type: 'blockquote'; readonly content: readonly ReleaseNoteBlock<Image>[] }
  | { readonly type: 'codeBlock'; readonly content?: readonly ReleaseNoteText[] }
  | { readonly type: 'horizontalRule' }
  | { readonly type: 'image'; readonly attrs: Image }
  | { readonly type: 'youtube'; readonly attrs: { readonly videoId: string } };

export interface ReleaseNoteListItem<Image> {
  readonly type: 'listItem';
  readonly content: readonly ReleaseNoteBlock<Image>[];
}

export interface ReleaseNoteDoc<Image> {
  readonly type: 'doc';
  readonly content: readonly ReleaseNoteBlock<Image>[];
}

export type StoredReleaseNoteDoc = ReleaseNoteDoc<StoredImageAttrs>;
export type ReleaseNoteViewDoc = ReleaseNoteDoc<ViewImageAttrs>;
export type ReleaseNoteEditorDoc = ReleaseNoteDoc<EditorImageAttrs>;

// =================================================================================================
// Ceilings
// =================================================================================================

export const MAX_RELEASE_NOTE_TITLE_LENGTH = 120;

/** The serialised document, in characters. Far above any post; a bound on the request. */
export const MAX_RELEASE_NOTE_BODY_LENGTH = 200_000;

export const MAX_RELEASE_NOTE_IMAGES = 30;

export const MAX_RELEASE_NOTE_VIDEOS = 10;

export const MAX_RELEASE_NOTE_IMAGE_ALT_LENGTH = 300;

/** How deep blocks may nest (a list in a quote in a list…). The reader recurses; this bounds it. */
const MAX_DEPTH = 8;

const MAX_LINK_LENGTH = 2_000;

/** How much of a post's text the list prints under its title. */
export const RELEASE_NOTE_EXCERPT_LENGTH = 180;

// =================================================================================================
// Pictures
// =================================================================================================

/**
 * A GIF is not re-encoded on the way up — a canvas would keep its first frame and lose the rest —
 * so the ceiling is the file's own size, and it is higher than a cover's for that reason.
 */
export const MAX_RELEASE_NOTE_IMAGE_BYTES = 10 * 1024 * 1024;

export const MAX_RELEASE_NOTE_IMAGE_LABEL = '10 MB';

export const ACCEPTED_RELEASE_NOTE_IMAGE_FORMATS = {
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
} as const;

export type ReleaseNoteImageContentType = keyof typeof ACCEPTED_RELEASE_NOTE_IMAGE_FORMATS;

export const ACCEPTED_RELEASE_NOTE_IMAGE_TYPES = Object.keys(
  ACCEPTED_RELEASE_NOTE_IMAGE_FORMATS,
) as readonly ReleaseNoteImageContentType[];

export const ACCEPTED_RELEASE_NOTE_IMAGE_LABEL = 'JPEG, PNG, WebP or GIF';

export function isAcceptedReleaseNoteImageType(value: unknown): value is ReleaseNoteImageContentType {
  return (
    typeof value === 'string' &&
    (ACCEPTED_RELEASE_NOTE_IMAGE_TYPES as readonly string[]).includes(value.trim().toLowerCase())
  );
}

export function extensionForReleaseNoteImageType(contentType: string): string | null {
  const wanted = contentType.trim().toLowerCase();
  return isAcceptedReleaseNoteImageType(wanted) ? ACCEPTED_RELEASE_NOTE_IMAGE_FORMATS[wanted] : null;
}

/** Where a post's pictures live in the store. A key outside it is never one of a post's pictures. */
export const RELEASE_NOTE_IMAGE_KEY_PREFIX = 'release-notes/';

// =================================================================================================
// YouTube
// =================================================================================================

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

/**
 * The video a YouTube link names, or `null` when it names none. Reads the forms a person copies:
 * a watch link, a `youtu.be` share link, a Shorts or live link, and an embed link.
 */
export function youtubeVideoId(input: string): string | null {
  const trimmed = input.trim();
  if (YOUTUBE_ID.test(trimmed)) return trimmed;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();
  let candidate: string | null = null;
  if (host === 'youtu.be') {
    candidate = url.pathname.split('/')[1] ?? null;
  } else if (YOUTUBE_HOSTS.has(host)) {
    const parts = url.pathname.split('/').filter((one) => one !== '');
    if (parts[0] === 'watch') candidate = url.searchParams.get('v');
    else if (parts[0] === 'embed' || parts[0] === 'shorts' || parts[0] === 'live' || parts[0] === 'v') {
      candidate = parts[1] ?? null;
    }
  }
  return candidate !== null && YOUTUBE_ID.test(candidate) ? candidate : null;
}

/** The frame a video plays in. The no-cookie host: watching a post is not a visit to YouTube. */
export const YOUTUBE_EMBED_ORIGIN = 'https://www.youtube-nocookie.com';

export function youtubeEmbedUrl(videoId: string): string {
  return `${YOUTUBE_EMBED_ORIGIN}/embed/${videoId}`;
}

/** The link the editor holds for a stored video — any form {@link youtubeVideoId} reads back. */
export function youtubeWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

// =================================================================================================
// Reading a document
// =================================================================================================

/** Why a body was refused, in words an admin can act on. The server answers it as `invalid_input`. */
export class ReleaseNoteDocError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReleaseNoteDocError';
  }
}

function refuse(message: string): never {
  throw new ReleaseNoteDocError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function children(node: Record<string, unknown>): unknown[] {
  const { content } = node;
  if (content === undefined || content === null) return [];
  if (!Array.isArray(content)) refuse('The post is not a document this accepts.');
  return content as unknown[];
}

/** A link a post may carry: the web, or an address to write to. Never a script. */
export function isSafeReleaseNoteHref(href: string): boolean {
  if (href.length > MAX_LINK_LENGTH) return false;
  try {
    const url = new URL(href);
    return url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:';
  } catch {
    return false;
  }
}

function parseMarks(value: unknown): ReleaseNoteMark[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) refuse('The post is not a document this accepts.');
  const marks: ReleaseNoteMark[] = [];
  for (const one of value as unknown[]) {
    if (!isRecord(one) || typeof one['type'] !== 'string') refuse('The post is not a document this accepts.');
    const type = one['type'];
    if ((RELEASE_NOTE_PLAIN_MARKS as readonly string[]).includes(type)) {
      marks.push({ type: type as ReleaseNotePlainMark });
      continue;
    }
    if (type === 'link') {
      const attrs = one['attrs'];
      const href = isRecord(attrs) && typeof attrs['href'] === 'string' ? attrs['href'].trim() : '';
      if (!isSafeReleaseNoteHref(href)) refuse('A link in the post is not a web address this accepts.');
      marks.push({ type: 'link', attrs: { href } });
      continue;
    }
    refuse(`The post uses formatting this does not accept (“${type}”).`);
  }
  return marks;
}

function parseText(node: Record<string, unknown>): ReleaseNoteText {
  const { text } = node;
  if (typeof text !== 'string' || text === '') refuse('The post is not a document this accepts.');
  const marks = parseMarks(node['marks']);
  return marks.length === 0 ? { type: 'text', text } : { type: 'text', text, marks };
}

function parseInlines(node: Record<string, unknown>): ReleaseNoteInline[] {
  return children(node).map((one) => {
    if (!isRecord(one)) refuse('The post is not a document this accepts.');
    if (one['type'] === 'text') return parseText(one);
    if (one['type'] === 'hardBreak') return { type: 'hardBreak' } as const;
    return refuse('The post is not a document this accepts.');
  });
}

interface Tally {
  images: number;
  videos: number;
}

function parseBlocks(node: Record<string, unknown>, depth: number, tally: Tally): ReleaseNoteBlock<StoredImageAttrs>[] {
  return children(node).map((one) => parseBlock(one, depth, tally));
}

function parseListItems(
  node: Record<string, unknown>,
  depth: number,
  tally: Tally,
): ReleaseNoteListItem<StoredImageAttrs>[] {
  const items = children(node).map((one) => {
    if (!isRecord(one) || one['type'] !== 'listItem') refuse('The post is not a document this accepts.');
    return { type: 'listItem', content: parseBlocks(one, depth + 1, tally) } as const;
  });
  if (items.length === 0) refuse('The post is not a document this accepts.');
  return items;
}

function parseBlock(value: unknown, depth: number, tally: Tally): ReleaseNoteBlock<StoredImageAttrs> {
  if (depth > MAX_DEPTH) refuse('The post nests lists and quotes too deeply.');
  if (!isRecord(value) || typeof value['type'] !== 'string') refuse('The post is not a document this accepts.');
  const attrs = isRecord(value['attrs']) ? value['attrs'] : {};
  switch (value['type']) {
    case 'paragraph': {
      const content = parseInlines(value);
      return content.length === 0 ? { type: 'paragraph' } : { type: 'paragraph', content };
    }
    case 'heading': {
      const level = attrs['level'];
      if (!(RELEASE_NOTE_HEADING_LEVELS as readonly unknown[]).includes(level)) {
        refuse('A heading in the post is not a size this accepts.');
      }
      const content = parseInlines(value);
      const base = { type: 'heading', attrs: { level: level as ReleaseNoteHeadingLevel } } as const;
      return content.length === 0 ? base : { ...base, content };
    }
    case 'bulletList':
      return { type: 'bulletList', content: parseListItems(value, depth, tally) };
    case 'orderedList':
      return { type: 'orderedList', content: parseListItems(value, depth, tally) };
    case 'blockquote':
      return { type: 'blockquote', content: parseBlocks(value, depth + 1, tally) };
    case 'codeBlock': {
      const content = children(value).map((one) => {
        if (!isRecord(one) || one['type'] !== 'text') refuse('The post is not a document this accepts.');
        // Code carries no formatting of its own; whatever marks arrived are not kept.
        const text = parseText(one);
        return { type: 'text', text: text.text } as const;
      });
      return content.length === 0 ? { type: 'codeBlock' } : { type: 'codeBlock', content };
    }
    case 'horizontalRule':
      return { type: 'horizontalRule' };
    case 'image': {
      tally.images += 1;
      if (tally.images > MAX_RELEASE_NOTE_IMAGES) {
        refuse(`A post can carry at most ${MAX_RELEASE_NOTE_IMAGES} pictures.`);
      }
      const key = typeof attrs['key'] === 'string' ? attrs['key'].trim() : '';
      if (key === '' || key.length > 512 || !key.startsWith(RELEASE_NOTE_IMAGE_KEY_PREFIX)) {
        refuse('A picture in the post did not finish uploading. Remove it and add it again.');
      }
      const rawAlt = typeof attrs['alt'] === 'string' ? attrs['alt'].replace(/\s+/g, ' ').trim() : '';
      if (rawAlt.length > MAX_RELEASE_NOTE_IMAGE_ALT_LENGTH) {
        refuse(`A picture's description can be at most ${MAX_RELEASE_NOTE_IMAGE_ALT_LENGTH} characters.`);
      }
      return { type: 'image', attrs: { key, alt: rawAlt === '' ? null : rawAlt } };
    }
    case 'youtube': {
      tally.videos += 1;
      if (tally.videos > MAX_RELEASE_NOTE_VIDEOS) {
        refuse(`A post can carry at most ${MAX_RELEASE_NOTE_VIDEOS} videos.`);
      }
      const source =
        typeof attrs['videoId'] === 'string'
          ? attrs['videoId']
          : typeof attrs['src'] === 'string'
            ? attrs['src']
            : '';
      const videoId = youtubeVideoId(source);
      if (videoId === null) refuse('A video in the post is not a YouTube link this can read.');
      return { type: 'youtube', attrs: { videoId } };
    }
    default:
      return refuse(`The post uses a kind of content this does not accept (“${value['type']}”).`);
  }
}

/**
 * Read a body — the editor's own output — into the document that is stored. Throws
 * {@link ReleaseNoteDocError} with a sentence for the admin when it is not one.
 *
 * A post with nothing in it is refused here too: a title over an empty page is not a post.
 */
export function parseReleaseNoteDoc(value: unknown): StoredReleaseNoteDoc {
  if (!isRecord(value) || value['type'] !== 'doc') refuse('Write the post.');
  let size: number;
  try {
    size = JSON.stringify(value).length;
  } catch {
    return refuse('The post is not a document this accepts.');
  }
  if (size > MAX_RELEASE_NOTE_BODY_LENGTH) refuse('The post is too long. Shorten it and save again.');
  const tally: Tally = { images: 0, videos: 0 };
  const content = parseBlocks(value, 0, tally);
  const doc: StoredReleaseNoteDoc = { type: 'doc', content };
  if (tally.images === 0 && tally.videos === 0 && releaseNoteText(doc).trim() === '') {
    refuse('Write the post.');
  }
  return doc;
}

// =================================================================================================
// Walking a document
// =================================================================================================

/** The same document with every image node's attributes replaced. `null` drops the picture. */
export function mapReleaseNoteImages<From, To>(
  doc: ReleaseNoteDoc<From>,
  map: (attrs: From) => To | null,
): ReleaseNoteDoc<To> {
  const mapBlocks = (blocks: readonly ReleaseNoteBlock<From>[]): ReleaseNoteBlock<To>[] =>
    blocks.flatMap((block): ReleaseNoteBlock<To>[] => {
      switch (block.type) {
        case 'image': {
          const attrs = map(block.attrs);
          return attrs === null ? [] : [{ type: 'image', attrs }];
        }
        case 'bulletList':
        case 'orderedList':
          return [
            {
              type: block.type,
              content: block.content.map((item) => ({ type: 'listItem', content: mapBlocks(item.content) })),
            },
          ];
        case 'blockquote':
          return [{ type: 'blockquote', content: mapBlocks(block.content) }];
        default:
          return [block];
      }
    });
  return { type: 'doc', content: mapBlocks(doc.content) };
}

/** Every picture a stored document names, in reading order. */
export function releaseNoteImageKeys(doc: StoredReleaseNoteDoc): string[] {
  const keys: string[] = [];
  mapReleaseNoteImages(doc, (attrs) => {
    keys.push(attrs.key);
    return attrs;
  });
  return keys;
}

/** The post's words, with a space between blocks — what the excerpt and the emptiness check read. */
export function releaseNoteText<Image>(doc: ReleaseNoteDoc<Image>): string {
  const parts: string[] = [];
  const inlines = (content: readonly ReleaseNoteInline[] | undefined): void => {
    const line = (content ?? []).map((one) => (one.type === 'text' ? one.text : ' ')).join('');
    if (line.trim() !== '') parts.push(line);
  };
  const blocks = (list: readonly ReleaseNoteBlock<Image>[]): void => {
    for (const block of list) {
      switch (block.type) {
        case 'paragraph':
        case 'heading':
        case 'codeBlock':
          inlines(block.content);
          break;
        case 'bulletList':
        case 'orderedList':
          for (const item of block.content) blocks(item.content);
          break;
        case 'blockquote':
          blocks(block.content);
          break;
        default:
          break;
      }
    }
  };
  blocks(doc.content);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

export function releaseNoteExcerpt<Image>(doc: ReleaseNoteDoc<Image>): string {
  const flat = releaseNoteText(doc);
  if (flat.length <= RELEASE_NOTE_EXCERPT_LENGTH) return flat;
  return `${flat.slice(0, RELEASE_NOTE_EXCERPT_LENGTH - 1).trimEnd()}…`;
}

// =================================================================================================
// The wire contract
// =================================================================================================

/** Relative to the `/api/v1` prefix. `GET` lists every post, newest first; `POST` creates one. */
export const RELEASE_NOTES_PATH = '/release-notes';

/** `GET` reads one post, `PATCH` edits it, `DELETE` removes it. */
export function releaseNotePath(id: string): string {
  return `${RELEASE_NOTES_PATH}/${id}`;
}

/** `GET` — the post as the editor needs it: every picture with its key beside its URL. Admin only. */
export function releaseNoteSourcePath(id: string): string {
  return `${RELEASE_NOTES_PATH}/${id}/source`;
}

/** `POST` — permission to send one picture for a post. Admin only. */
export const RELEASE_NOTE_IMAGE_UPLOADS_PATH = `${RELEASE_NOTES_PATH}/images/uploads`;

/** The list, on the web origin. */
export const RELEASE_NOTES_PAGE_PATH = '/release-notes';

/** One post, on the web origin — where a new-feature notification lands. */
export function releaseNotePagePath(id: string): string {
  return `${RELEASE_NOTES_PAGE_PATH}/${id}`;
}

/** The console's panel for writing them. */
export const ADMIN_RELEASE_NOTES_PAGE_PATH = '/admin/release-notes';

/** One post as the list prints it. */
export interface ReleaseNoteSummary {
  readonly id: string;
  readonly title: string;
  readonly excerpt: string;
  /** ISO 8601. */
  readonly publishedAt: string;
  /** ISO 8601. Equal to `publishedAt` on a post never edited. */
  readonly updatedAt: string;
}

/** One post, whole, as a member reads it. */
export interface ReleaseNoteView extends ReleaseNoteSummary {
  readonly body: ReleaseNoteViewDoc;
}

/** One post as the editor opens it. */
export interface ReleaseNoteSource extends ReleaseNoteSummary {
  readonly body: ReleaseNoteEditorDoc;
}

/** Payload of `GET /api/v1/release-notes`. */
export interface ReleaseNoteListPayload {
  readonly releaseNotes: readonly ReleaseNoteSummary[];
}

/** Payload of `GET /api/v1/release-notes/{id}`. */
export interface ReleaseNotePayload {
  readonly releaseNote: ReleaseNoteView;
}

/** Payload of `GET /api/v1/release-notes/{id}/source`. */
export interface ReleaseNoteSourcePayload {
  readonly releaseNote: ReleaseNoteSource;
}

/**
 * Body of `POST /api/v1/release-notes` and `PATCH /api/v1/release-notes/{id}`. `body` is the
 * editor's document as it stands; the server reads it with {@link parseReleaseNoteDoc}.
 */
export interface SaveReleaseNoteRequest {
  readonly title: string;
  readonly body: unknown;
}

/** Payload of a create or an edit — the post as the list now prints it. */
export interface SaveReleaseNotePayload {
  readonly releaseNote: ReleaseNoteSummary;
}

/** Payload of `DELETE /api/v1/release-notes/{id}`. */
export interface DeleteReleaseNotePayload {
  readonly deleted: true;
}
