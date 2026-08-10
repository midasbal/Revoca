import { Link } from 'react-router-dom';
import { useReducedMotion } from 'framer-motion';
import { RingMark } from '../components/RingMark';
import { usePositionsRegistry } from '../hooks/usePositionsRegistry';
import { positionStatus } from '../positionStatus';
import { formatAmount, formatBps, shortAddress } from '../chain';

const NOOP = () => {};

/**
 * The system-wide view: every real open position in the pool, live
 * standing, not one record. Addresses are discovered from real on-chain
 * history (see usePositionsRegistry.ts's header on why that discovery is
 * itself a progressive scan, not instant, on Monad's public RPC), so the
 * registry can genuinely still be filling in while it's on screen, shown
 * honestly rather than hidden.
 */
export default function PositionsPage() {
  const prefersReduced = useReducedMotion();
  const registry = usePositionsRegistry();

  const valid = registry.entries.filter((e) => positionStatus(e).phase === 'valid').length;
  const struck = registry.entries.length - valid;

  // Struck/resolved positions are the strongest evidence of the compliance
  // gate actually working, surface them first rather than let them sit
  // buried mid-scan behind ordinary valid ones.
  const orderedEntries = [...registry.entries].sort((a, b) => {
    const aStruck = positionStatus(a).phase === 'struck';
    const bStruck = positionStatus(b).phase === 'struck';
    return aStruck === bStruck ? 0 : aStruck ? -1 : 1;
  });

  return (
    <div className="page-wrap">
      <div className="registry-head">
        <p className="eyebrow">Positions</p>
        <h1 className="registry-head__title">The registry, position by position</h1>
        <p className="registry-head__lede">
          Every open position in the pool, standing read live against the same compliance gate and registry every
          borrow actually checks, not a cached list.
        </p>
      </div>

      <div className="registry-status">
        <span className="registry-status__count mono">
          {registry.entries.length} open &middot; {valid} valid &middot; {struck} struck or in grace
        </span>
        {registry.discovering && (
          <span className="registry-status__scanning mono">
            Scanning chain history for more&hellip; block {registry.scannedBlock.toLocaleString('en-US')} of{' '}
            {registry.targetBlock.toLocaleString('en-US')} ({registry.addressesDiscovered} addresses seen)
          </span>
        )}
      </div>

      {registry.loadingEntries && registry.entries.length === 0 ? (
        <p className="notice" style={{ marginTop: 'var(--space-5)' }}>
          Reading live positions&hellip;
        </p>
      ) : registry.entries.length === 0 ? (
        <p className="notice" style={{ marginTop: 'var(--space-5)' }}>
          {registry.discovering
            ? 'No open positions found yet, still scanning the chain for the pool’s real history.'
            : 'No open positions in the pool right now. This is a real, honest empty registry, not a placeholder.'}
        </p>
      ) : (
        <ol className="registry-list">
          {orderedEntries.map((entry) => {
            const status = positionStatus(entry);
            return (
              <li key={entry.address}>
                <Link
                  to={`/positions/${entry.address}`}
                  className={`registry-row${status.phase === 'struck' ? ' registry-row--struck' : ''}`}
                >
                  <span className="registry-row__ring" aria-hidden="true">
                    <RingMark phase={status.phase} prefersReduced={prefersReduced} onStrikeComplete={NOOP} />
                  </span>
                  <span className="registry-row__body">
                    <span className="registry-row__address mono">{shortAddress(entry.address)}</span>
                    <span className="registry-row__meta">
                      {status.label} &middot; {status.detail}
                    </span>
                  </span>
                  <span className="registry-row__stats">
                    <span className="registry-row__stat">
                      <span className="registry-row__stat-label">Ratio</span>
                      <span className="registry-row__stat-value mono">{formatBps(entry.ratioBps)}</span>
                    </span>
                    <span className="registry-row__stat">
                      <span className="registry-row__stat-label">Collateral</span>
                      <span className="registry-row__stat-value mono">{formatAmount(entry.collateral)}</span>
                    </span>
                    <span className="registry-row__stat">
                      <span className="registry-row__stat-label">Debt</span>
                      <span className="registry-row__stat-value mono">{formatAmount(entry.debt)}</span>
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
