import type { ReactNode } from 'react';
import {
  youtubeEmbedUrl,
  type ReleaseNoteBlock,
  type ReleaseNoteInline,
  type ReleaseNoteMark,
  type ReleaseNoteViewDoc,
  type ViewImageAttrs,
} from '@thp/shared';
import styles from './release-notes.module.css';

/**
 * **A post's body, painted from its document.**
 *
 * The body arrives as a tree of a fixed set of node types (`release-notes.ts` in `@thp/shared`),
 * and this draws one element per node. Nothing here sets markup from a string: a node type this
 * does not know is not drawn, which cannot happen for a stored post — the server refuses one — and
 * is the right answer for anything else.
 *
 * A video is YouTube's own player in a frame, from the no-cookie host; a picture is a signed URL,
 * and a GIF is simply a picture that moves.
 */

function withMarks(text: string, marks: readonly ReleaseNoteMark[] | undefined): ReactNode {
  let node: ReactNode = text;
  for (const mark of marks ?? []) {
    switch (mark.type) {
      case 'bold':
        node = <strong>{node}</strong>;
        break;
      case 'italic':
        node = <em>{node}</em>;
        break;
      case 'underline':
        node = <u>{node}</u>;
        break;
      case 'strike':
        node = <s>{node}</s>;
        break;
      case 'code':
        node = <code className={styles.code}>{node}</code>;
        break;
      case 'link':
        node = (
          <a className={styles.link} href={mark.attrs.href} target="_blank" rel="noopener noreferrer">
            {node}
          </a>
        );
        break;
      default:
        break;
    }
  }
  return node;
}

function Inlines({ content }: { content: readonly ReleaseNoteInline[] | undefined }) {
  return (
    <>
      {(content ?? []).map((one, index) =>
        one.type === 'hardBreak' ? (
          <br key={index} />
        ) : (
          <span key={index}>{withMarks(one.text, one.marks)}</span>
        ),
      )}
    </>
  );
}

function Blocks({ blocks }: { blocks: readonly ReleaseNoteBlock<ViewImageAttrs>[] }) {
  return (
    <>
      {blocks.map((block, index) => (
        <Block key={index} block={block} />
      ))}
    </>
  );
}

function Block({ block }: { block: ReleaseNoteBlock<ViewImageAttrs> }) {
  switch (block.type) {
    case 'paragraph':
      return (
        <p className={styles.paragraph}>
          <Inlines content={block.content} />
        </p>
      );
    case 'heading':
      return block.attrs.level === 2 ? (
        <h2 className={styles.heading}>
          <Inlines content={block.content} />
        </h2>
      ) : (
        <h3 className={styles.subheading}>
          <Inlines content={block.content} />
        </h3>
      );
    case 'bulletList':
    case 'orderedList': {
      const items = block.content.map((item, index) => (
        <li key={index}>
          <Blocks blocks={item.content} />
        </li>
      ));
      return block.type === 'bulletList' ? (
        <ul className={styles.list}>{items}</ul>
      ) : (
        <ol className={styles.list}>{items}</ol>
      );
    }
    case 'blockquote':
      return (
        <blockquote className={styles.quote}>
          <Blocks blocks={block.content} />
        </blockquote>
      );
    case 'codeBlock':
      return (
        <pre className={styles.codeBlock}>
          <code>{(block.content ?? []).map((one) => one.text).join('')}</code>
        </pre>
      );
    case 'horizontalRule':
      return <hr className={styles.rule} />;
    case 'image':
      return (
        <figure className={styles.figure}>
          <img className={styles.image} src={block.attrs.src} alt={block.attrs.alt ?? ''} loading="lazy" />
        </figure>
      );
    case 'youtube':
      return (
        <div className={styles.video}>
          <iframe
            className={styles.videoFrame}
            src={youtubeEmbedUrl(block.attrs.videoId)}
            title="YouTube video"
            loading="lazy"
            allow="accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
        </div>
      );
    default:
      return null;
  }
}

export function ReleaseNoteBody({ doc }: { doc: ReleaseNoteViewDoc }) {
  return (
    <div className={styles.body}>
      <Blocks blocks={doc.content} />
    </div>
  );
}
