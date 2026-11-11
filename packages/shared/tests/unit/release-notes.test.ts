import { describe, expect, it } from 'vitest';
import {
  MAX_RELEASE_NOTE_IMAGES,
  RELEASE_NOTE_EXCERPT_LENGTH,
  ReleaseNoteDocError,
  extensionForReleaseNoteImageType,
  isAcceptedReleaseNoteImageType,
  isSafeReleaseNoteHref,
  mapReleaseNoteImages,
  parseReleaseNoteDoc,
  releaseNoteExcerpt,
  releaseNoteImageKeys,
  releaseNoteText,
  youtubeEmbedUrl,
  youtubeVideoId,
} from '../../src/release-notes';

/**
 * **The release-note document, read by its one parser.**
 *
 * What the server stores and what a member's screen paints are both downstream of
 * `parseReleaseNoteDoc`, so what it accepts is what a post can be: the editor's own node types,
 * normalised, and nothing else — an unknown node is refused rather than dropped.
 */

const text = (value: string, marks?: unknown[]) =>
  marks === undefined ? { type: 'text', text: value } : { type: 'text', text: value, marks };
const paragraph = (...content: unknown[]) => ({ type: 'paragraph', content });
const doc = (...content: unknown[]) => ({ type: 'doc', content });

function refusal(value: unknown): string {
  try {
    parseReleaseNoteDoc(value);
  } catch (caught) {
    if (caught instanceof ReleaseNoteDocError) return caught.message;
    throw caught;
  }
  throw new Error('the document was accepted');
}

describe('a YouTube link names a video', () => {
  const ID = 'dQw4w9WgXcQ';

  it('in every form a person copies', () => {
    expect(youtubeVideoId(`https://www.youtube.com/watch?v=${ID}`)).toBe(ID);
    expect(youtubeVideoId(`https://www.youtube.com/watch?v=${ID}&t=42s`)).toBe(ID);
    expect(youtubeVideoId(`https://youtu.be/${ID}?si=abc`)).toBe(ID);
    expect(youtubeVideoId(`https://m.youtube.com/watch?v=${ID}`)).toBe(ID);
    expect(youtubeVideoId(`https://www.youtube.com/shorts/${ID}`)).toBe(ID);
    expect(youtubeVideoId(`https://www.youtube.com/embed/${ID}`)).toBe(ID);
    expect(youtubeVideoId(`https://www.youtube-nocookie.com/embed/${ID}`)).toBe(ID);
    expect(youtubeVideoId(ID)).toBe(ID);
  });

  it('and nothing else does', () => {
    expect(youtubeVideoId('https://vimeo.com/123456789')).toBeNull();
    expect(youtubeVideoId(`https://youtube.com.evil.test/watch?v=${ID}`)).toBeNull();
    expect(youtubeVideoId('https://www.youtube.com/watch?v=short')).toBeNull();
    expect(youtubeVideoId(`javascript:alert('${ID}')`)).toBeNull();
    expect(youtubeVideoId('')).toBeNull();
  });

  it('plays from the no-cookie host', () => {
    expect(youtubeEmbedUrl(ID)).toBe(`https://www.youtube-nocookie.com/embed/${ID}`);
  });
});

describe('what a post may link to', () => {
  it('the web and an address to write to, and never a script', () => {
    expect(isSafeReleaseNoteHref('https://example.test/page')).toBe(true);
    expect(isSafeReleaseNoteHref('http://example.test')).toBe(true);
    expect(isSafeReleaseNoteHref('mailto:someone@example.test')).toBe(true);
    expect(isSafeReleaseNoteHref('javascript:alert(1)')).toBe(false);
    expect(isSafeReleaseNoteHref('data:text/html,<script>1</script>')).toBe(false);
    expect(isSafeReleaseNoteHref('/relative')).toBe(false);
  });
});

describe('which pictures a post accepts', () => {
  it('a GIF beside the three a cover accepts', () => {
    expect(isAcceptedReleaseNoteImageType('image/gif')).toBe(true);
    expect(isAcceptedReleaseNoteImageType('IMAGE/PNG')).toBe(true);
    expect(isAcceptedReleaseNoteImageType('image/svg+xml')).toBe(false);
    expect(extensionForReleaseNoteImageType('image/gif')).toBe('gif');
    expect(extensionForReleaseNoteImageType('text/html')).toBeNull();
  });
});

describe('reading the editor’s document', () => {
  it('keeps the text, the formatting, the lists, a picture and a video — normalised', () => {
    const parsed = parseReleaseNoteDoc(
      doc(
        { type: 'heading', attrs: { level: 2, textAlign: null }, content: [text('What is new')] },
        paragraph(
          text('Bold', [{ type: 'bold' }]),
          { type: 'hardBreak' },
          text('a link', [
            { type: 'link', attrs: { href: 'https://example.test', target: '_blank', class: null } },
          ]),
        ),
        {
          type: 'bulletList',
          content: [{ type: 'listItem', content: [paragraph(text('one'))] }],
        },
        {
          type: 'image',
          attrs: { src: 'blob:whatever', key: 'release-notes/abc.gif', alt: '  A  moving picture ', title: null },
        },
        {
          type: 'youtube',
          attrs: { src: 'https://youtu.be/dQw4w9WgXcQ', start: 0, width: 640, height: 360 },
        },
      ),
    );

    expect(parsed.content).toEqual([
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'What is new' }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Bold', marks: [{ type: 'bold' }] },
          { type: 'hardBreak' },
          { type: 'text', text: 'a link', marks: [{ type: 'link', attrs: { href: 'https://example.test' } }] },
        ],
      },
      {
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] },
        ],
      },
      // The URL the editor painted is not stored: the key is, and a read signs it.
      { type: 'image', attrs: { key: 'release-notes/abc.gif', alt: 'A moving picture' } },
      { type: 'youtube', attrs: { videoId: 'dQw4w9WgXcQ' } },
    ]);
    expect(releaseNoteImageKeys(parsed)).toEqual(['release-notes/abc.gif']);
  });

  it('accepts a post that is only a picture or only a video', () => {
    expect(() =>
      parseReleaseNoteDoc(doc({ type: 'image', attrs: { key: 'release-notes/a.png' } })),
    ).not.toThrow();
    expect(() =>
      parseReleaseNoteDoc(doc({ type: 'youtube', attrs: { videoId: 'dQw4w9WgXcQ' } })),
    ).not.toThrow();
  });

  it('refuses an empty post, in words', () => {
    expect(refusal(null)).toBe('Write the post.');
    expect(refusal(doc())).toBe('Write the post.');
    expect(refusal(doc({ type: 'paragraph' }, paragraph(text('   '))))).toBe('Write the post.');
  });

  it('refuses a node, a mark or a heading size it does not know, rather than dropping it', () => {
    expect(refusal(doc({ type: 'iframe', attrs: { src: 'https://evil.test' } }))).toContain('iframe');
    expect(refusal(doc(paragraph(text('x', [{ type: 'textStyle', attrs: { color: 'red' } }]))))).toContain(
      'textStyle',
    );
    expect(refusal(doc({ type: 'heading', attrs: { level: 1 }, content: [text('x')] }))).toContain(
      'heading',
    );
  });

  it('refuses a link that is not a web address', () => {
    expect(
      refusal(doc(paragraph(text('x', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }])))),
    ).toContain('link');
  });

  it('refuses a picture with no upload behind it, or one from another prefix', () => {
    expect(refusal(doc({ type: 'image', attrs: { src: 'https://elsewhere.test/a.png' } }))).toContain(
      'did not finish uploading',
    );
    expect(refusal(doc({ type: 'image', attrs: { key: 'originals/teaching.mp3' } }))).toContain(
      'did not finish uploading',
    );
  });

  it('refuses a video that is not on YouTube', () => {
    expect(refusal(doc({ type: 'youtube', attrs: { src: 'https://vimeo.com/1' } }))).toContain('YouTube');
  });

  it('refuses more pictures than a post carries', () => {
    const many = Array.from({ length: MAX_RELEASE_NOTE_IMAGES + 1 }, (_, index) => ({
      type: 'image',
      attrs: { key: `release-notes/${index}.png` },
    }));
    expect(refusal(doc(...many))).toContain(String(MAX_RELEASE_NOTE_IMAGES));
  });

  it('refuses nesting deeper than a reader should recurse', () => {
    let nested: unknown = paragraph(text('deep'));
    for (let depth = 0; depth < 12; depth += 1) nested = { type: 'blockquote', content: [nested] };
    expect(refusal(doc(nested))).toContain('deeply');
  });
});

describe('walking a stored document', () => {
  const stored = parseReleaseNoteDoc(
    doc(
      paragraph(text('First line.')),
      {
        type: 'blockquote',
        content: [{ type: 'image', attrs: { key: 'release-notes/in-quote.png' } }, paragraph(text('Quoted.'))],
      },
      { type: 'image', attrs: { key: 'release-notes/gone.png' } },
    ),
  );

  it('replaces every picture, wherever it is nested, and drops one that maps to nothing', () => {
    const view = mapReleaseNoteImages(stored, (attrs) =>
      attrs.key.endsWith('gone.png') ? null : { src: `https://signed.test/${attrs.key}`, alt: attrs.alt },
    );
    expect(JSON.stringify(view)).not.toContain('"key"');
    expect(JSON.stringify(view)).toContain('https://signed.test/release-notes/in-quote.png');
    expect(view.content).toHaveLength(2);
  });

  it('reads the words in order, and cuts the excerpt with an ellipsis', () => {
    expect(releaseNoteText(stored)).toBe('First line. Quoted.');
    const long = parseReleaseNoteDoc(doc(paragraph(text('word '.repeat(100)))));
    const excerpt = releaseNoteExcerpt(long);
    expect(excerpt.length).toBeLessThanOrEqual(RELEASE_NOTE_EXCERPT_LENGTH);
    expect(excerpt.endsWith('…')).toBe(true);
  });
});
