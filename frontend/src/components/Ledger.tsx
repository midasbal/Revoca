import { motion } from 'framer-motion';
import type { LedgerEntry } from '../hooks/useLedger';
import { explorerTxUrl, shortHash } from '../chain';

function relativeTime(timestamp: bigint | null, nowSeconds: number): string {
  if (timestamp === null) return '';
  const diff = nowSeconds - Number(timestamp);
  if (diff < 5) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

export function Ledger({ entries, nowSeconds, loading }: { entries: LedgerEntry[]; nowSeconds: number; loading?: boolean }) {
  if (entries.length === 0) {
    return <p className="ledger__empty">{loading ? 'Reading the ledger…' : 'No events recorded yet for this position.'}</p>;
  }

  return (
    <ol className="ledger">
      {entries.map((entry, index) => (
        <motion.li
          key={entry.key}
          className="ledger__row"
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
        >
          <span className="ledger__index mono">{String(index + 1).padStart(2, '0')}</span>
          <span className="ledger__body">
            <span className="ledger__step">{entry.headline}</span>
            {entry.detail && <span className="ledger__detail">{entry.detail}</span>}
          </span>
          <span className="ledger__meta">
            <span>{relativeTime(entry.timestamp, nowSeconds)}</span>
            <a href={explorerTxUrl(entry.transactionHash)} target="_blank" rel="noreferrer">
              {shortHash(entry.transactionHash)}
            </a>
          </span>
        </motion.li>
      ))}
    </ol>
  );
}
