import type { TagRef } from '@thp/shared';
import styles from './screens.module.css';

/**
 * **The tags on a teaching or a study, as a member reads them** ([4.7](docs/project/prd.md)).
 *
 * Labels and nothing more: they are not links and not filters. [3.10](docs/project/prd.md) is
 * where a tag becomes something to search or narrow by, and a pill that looks pressable but is not
 * is worse than one that plainly is not — so these are list items, not buttons, and take no hover.
 *
 * Absent entirely for an item with no tags, which is the ordinary state: nothing reserves an empty
 * row for labels that do not exist, the same line the cover and the description already draw.
 */
export function TagLabels({ tags }: { tags: readonly TagRef[] }) {
  if (tags.length === 0) return null;
  return (
    <ul className={styles.tagList} aria-label="Tags">
      {tags.map((tag) => (
        <li key={tag.id} className={styles.tag}>
          {tag.name}
        </li>
      ))}
    </ul>
  );
}
