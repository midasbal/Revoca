import { usePoolState } from '../hooks/usePoolState';
import { usePositionsRegistry } from '../hooks/usePositionsRegistry';
import { positionStatus } from '../positionStatus';
import { formatAmount, formatBps } from '../chain';

const SECONDS_PER_YEAR = 31_536_000n;

/**
 * The lender-facing risk composition, not just TVL: how much of the
 * pool's exposure sits in under-collateralized (high-tier) positions,
 * how many positions are currently flagged or unwinding, live utilization.
 * Everything here is derived from the same real reads the borrower and
 * registry pages use, no separate risk model, no invented numbers.
 */
export default function PoolPage() {
  const pool = usePoolState();
  const registry = usePositionsRegistry();

  const underCollateralized = registry.entries.filter((e) => e.ratioBps < 10_000);
  const underCollateralizedDebt = underCollateralized.reduce((sum, e) => sum + e.debt, 0n);
  const totalOpenDebt = registry.entries.reduce((sum, e) => sum + e.debt, 0n);

  const struckCount = registry.entries.filter((e) => positionStatus(e).phase === 'struck').length;

  const byBand = new Map<string, { ratioBps: number; count: number; debt: bigint; collateral: bigint }>();
  for (const entry of registry.entries) {
    const key = `${entry.tier}/${entry.subTier}`;
    const existing = byBand.get(key);
    if (existing) {
      existing.count += 1;
      existing.debt += entry.debt;
      existing.collateral += entry.collateral;
    } else {
      byBand.set(key, { ratioBps: entry.ratioBps, count: 1, debt: entry.debt, collateral: entry.collateral });
    }
  }
  const bands = [...byBand.entries()].sort((a, b) => a[1].ratioBps - b[1].ratioBps);

  return (
    <div className="page-wrap">
      <div className="registry-head">
        <p className="eyebrow">Pool</p>
        <h1 className="registry-head__title">What the pool is actually exposed to</h1>
        <p className="registry-head__lede">
          Not total value locked. This is the pool&rsquo;s real compliance-risk composition: how much exposure sits in
          under-collateralized positions, how many positions are currently reacting to a compliance change, all
          derived live from the same on-chain state the borrower and registry pages read.
        </p>
      </div>

      {pool.status === 'error' && <p className="notice">Could not read the pool: {pool.message}</p>}

      {pool.status === 'ready' && (
        <div className="borrower-card" style={{ marginTop: 'var(--space-6)' }}>
          <div className="record__header">
            <span className="eyebrow">Liquidity</span>
            <span className="eyebrow record__live">
              <span className="record__live-dot" aria-hidden="true" />
              Live, Monad testnet
            </span>
          </div>

          <div className="stats" style={{ marginTop: 'var(--space-5)' }}>
            <div className="stat">
              <p className="eyebrow stat__label">Total pooled</p>
              <p className="stat__value">
                {formatAmount(pool.data.totalPooledAssets)}
                <span className="stat__unit">rtUSD</span>
              </p>
            </div>
            <div className="stat">
              <p className="eyebrow stat__label">Utilization</p>
              <p className="stat__value">{formatBps(pool.data.utilizationBps)}</p>
            </div>
            <div className="stat">
              <p className="eyebrow stat__label">Borrow rate</p>
              <p className="stat__value">
                {((Number(pool.data.ratePerSecondBps * SECONDS_PER_YEAR) / 100) / 100).toFixed(0)}
                <span className="stat__unit">% APR, demo-tuned</span>
              </p>
            </div>
          </div>

          <p className="notice" style={{ marginTop: '0.75rem' }}>
            {formatAmount(pool.data.idleLiquidity)} rtUSD idle &middot; {formatAmount(pool.data.totalPrincipalOutstanding)} rtUSD out on
            loan
          </p>
        </div>
      )}

      <div className="borrower-card" style={{ marginTop: 'var(--space-6)' }}>
        <p className="eyebrow">Compliance exposure</p>

        <div className="stats" style={{ marginTop: 'var(--space-5)' }}>
          <div className="stat">
            <p className="eyebrow stat__label">Open positions</p>
            <p className="stat__value">{registry.entries.length}</p>
          </div>
          <div className="stat">
            <p className="eyebrow stat__label">Struck or in grace</p>
            <p className="stat__value" style={{ color: struckCount > 0 ? 'var(--struck)' : undefined }}>
              {struckCount}
            </p>
          </div>
          <div className="stat">
            <p className="eyebrow stat__label">Under-collateralized debt</p>
            <p className="stat__value">
              {formatAmount(underCollateralizedDebt)}
              <span className="stat__unit">rtUSD</span>
            </p>
          </div>
        </div>

        <p className="notice" style={{ marginTop: '0.75rem' }}>
          {totalOpenDebt > 0n
            ? `${((Number(underCollateralizedDebt * 10_000n / totalOpenDebt)) / 100).toFixed(1)}% of all outstanding debt sits in positions borrowed below 100% collateral, the pool’s real tier-scaled risk, not a hypothetical.`
            : 'No outstanding debt right now, nothing to weigh against under-collateralization.'}
        </p>

        {registry.discovering && (
          <p className="notice" style={{ marginTop: '0.5rem' }}>
            Still scanning chain history for more positions (block {registry.scannedBlock.toLocaleString('en-US')} of{' '}
            {registry.targetBlock.toLocaleString('en-US')}), these figures will grow as more real history is found.
          </p>
        )}

        {bands.length > 0 && (
          <>
            <div className="ruled">
              <span className="eyebrow ruled__label">Exposure by tier</span>
            </div>
            <ul className="band-table">
              {bands.map(([key, band]) => (
                <li key={key} className="band-table__row">
                  <span className="band-table__tier mono">
                    Tier {key} &middot; {formatBps(band.ratioBps)} required &middot; {band.count} position{band.count === 1 ? '' : 's'}
                  </span>
                  <span className="band-table__ratio">{formatAmount(band.debt)} rtUSD</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
