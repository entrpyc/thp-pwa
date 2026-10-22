import Link from 'next/link';
import {
  DELETE_ACCOUNT_PAGE_PATH,
  PRIVACY_PAGE_PATH,
  SUPPORT_PAGE_PATH,
  TERMS_PAGE_PATH,
} from '@thp/shared';
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
 * Grows only with the pages: a link to a page that is not there yet would be a link to a 404, so
 * each ticket that adds a page adds its entry here, and nothing else about either surface changes.
 * The four the app stores require are here: Apple 5.1.1(i) and Google's listing rules for the
 * policy, Apple 1.2 for contact, Google's UGC policy for the terms, and Google Play's
 * account-deletion policy for the request page, whose URL the store listing carries
 * (docs/project/store-declarations.md).
 *
 * The order is the order a store reviewer reads them in: the policy first, because it is the one a
 * listing links to; then the terms a member accepts; then where to write when neither answers; and
 * last the request page, which is the one link here a member is meant to need once.
 */
export const LEGAL_LINKS: readonly LegalLink[] = [
  { href: PRIVACY_PAGE_PATH, label: 'Privacy policy' },
  { href: TERMS_PAGE_PATH, label: 'Terms' },
  { href: SUPPORT_PAGE_PATH, label: 'Support' },
  { href: DELETE_ACCOUNT_PAGE_PATH, label: 'Delete account' },
];

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
