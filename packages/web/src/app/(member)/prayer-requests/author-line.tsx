import { monogramFor, type SosAuthorView } from '@thp/shared';
import { whenRaised } from './format';
import styles from './sos.module.css';

/**
 * Who wrote it and when — the notes panel's author line, for a signal and for a reply. The
 * picture when the author has one, the initials when they do not ([3.1.12](docs/project/prd.md));
 * decorative either way, because the name is printed beside it.
 */
export function AuthorLine({ author, at }: { author: SosAuthorView; at: string }) {
  return (
    <div className={styles.who}>
      {author.avatarUrl === null ? (
        <span className={styles.monogram} aria-hidden="true">
          {monogramFor(author.displayName)}
        </span>
      ) : (
        <img className={styles.avatar} src={author.avatarUrl} alt="" />
      )}
      <span className={styles.author}>{author.displayName}</span>
      <span className={styles.when}>{whenRaised(at)}</span>
    </div>
  );
}
