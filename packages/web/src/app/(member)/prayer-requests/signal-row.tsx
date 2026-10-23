import Link from 'next/link';
import { SOS_URGENCY_LABEL, sosPagePath, type SosSignalView } from '@thp/shared';
import { whenRaised } from './format';
import { UrgencyDot } from './urgency-dot';
import styles from './sos.module.css';

/**
 * One signal as the board and the home card list it: the dot and the urgency word, who raised it
 * and when, two lines of the request, and how many are praying and replying. The whole row is the
 * link to the signal's page, where everything else lives.
 */
export function SignalRow({ signal }: { signal: SosSignalView }) {
  const praying =
    signal.prayingCount === 1 ? '1 praying' : `${signal.prayingCount} praying`;
  const replies =
    signal.replyCount === 0
      ? null
      : signal.replyCount === 1
        ? '1 reply'
        : `${signal.replyCount} replies`;
  return (
    <Link className={styles.row} href={sosPagePath(signal.id)}>
      <span className={styles.rowText}>
        <span className={styles.rowLead}>
          <UrgencyDot urgency={signal.urgency} />
          <span className={styles.rowUrgency}>{SOS_URGENCY_LABEL[signal.urgency]}</span>
          <span>· {signal.author.displayName}</span>
          <span>· {whenRaised(signal.raisedAt)}</span>
        </span>
        <span className={styles.rowDescription}>{signal.description}</span>
        <span className={styles.rowMeta}>
          {praying}
          {replies === null ? '' : ` · ${replies}`}
          {signal.closedAt === null ? '' : ' · resolved'}
        </span>
      </span>
      <span className={styles.rowChevron} aria-hidden="true">
        ›
      </span>
    </Link>
  );
}
