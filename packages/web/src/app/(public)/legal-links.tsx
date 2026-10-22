import Link from 'next/link';
import styles from './legal-links.module.css';

export interface LegalLink {
  readonly href: string;
  readonly label: string;
}

/**
 * **The links every surface that offers them offers in the same order.** The sign-in footer and the
 * profile both read this list, so a policy added for one is added for both and the two cannot
 * disagree about what the product publishes.
 *
 * Empty until the pages exist: the tickets that add the privacy policy, the terms, support and the
 * account-deletion request each add their entry here, and nothing else about either surface
 * changes. A link to a page that is not there yet would be a link to a 404, so the list grows only
 * with the pages.
 */
export const LEGAL_LINKS: readonly LegalLink[] = [];

/**
 * A row of the product's legal and support links.
 *
 * **Renders nothing when there is nothing to link to** — not an empty row, not a bordered footer
 * with no contents. The codebase's rule for a destination that does not exist yet is that it is
 * dropped rather than shown disabled or empty, and that is why the border a host wants around the
 * row travels in `className` rather than in a wrapper the host draws: when the row is absent the
 * border is absent with it.
 *
 * A `<nav>` with a name, so a screen reader can skip it or jump to it as a landmark; a list inside,
 * so the number of links is announced before they are read.
 */
export function LegalLinks({
  links = LEGAL_LINKS,
  className,
}: {
  readonly links?: readonly LegalLink[];
  /** `| undefined` because a CSS-module lookup is one, and the host should not have to say so. */
  readonly className?: string | undefined;
}) {
  if (links.length === 0) return null;

  return (
    <nav aria-label="Legal" className={className === undefined ? styles.row : `${styles.row} ${className}`}>
      <ul className={styles.list}>
        {links.map((link) => (
          <li key={link.href}>
            <Link className={styles.link} href={link.href}>
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
