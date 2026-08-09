import { usePoolState } from '../hooks/usePoolState';
import { usePositionsRegistry } from '../hooks/usePositionsRegistry';
import { positionStatus } from '../positionStatus';
import { formatAmount, formatBps } from '../chain';
import { CompositionBar, CompositionLegend, type CompositionSegment } from '../components/pool/CompositionBar';

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

  const totalOpenDebt = registry.entries.reduce((sum, e) => sum + e.debt, 0n);
  const totalCollateral = registry.entries.reduce((sum, e) => sum + e.collateral, 0n);
  const underCollateralized = registry.entries.filter((e) => e.ratioBps < 10_000);
  const underCollateralizedDebt = underCollateralized.reduce((sum, e) => sum + e.debt, 0n);

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

  // Weighted by outstanding debt where any exists (the real exposure the pool carries); falls back to posted
  // collateral so the view still reads honestly when positions are open but nothing has been borrowed yet.
  const weighByDebt = totalOpenDebt > 0n;
  const weightOf = (band: { debt: bigint; collateral: bigint }) => Number(weighByDebt ? band.debt : band.collateral);

  const safeBandCount = bands.filter(([, b]) => b.ratioBps >= 10_000).length;
  let safeBandIndex = 0;
  const exposureSegments: CompositionSegment[] = bands.map(([key, band]) => {
    const risky = band.ratioBps < 10_000;
    const shade = risky ? undefined : safeBandCount <= 1 ? 1 : 1 - (safeBandIndex++ / (safeBandCount - 1)) * 0.5;
    return {
      key,
      label: `Tier ${key}`,
      detail: `${formatBps(band.ratioBps)} required · ${band.count} position${band.count === 1 ? '' : 's'} · ${formatAmount(weighByDebt ? band.debt : band.collateral)} rtUSD`,
      weight: weightOf(band),
      tone: risky ? 'struck' : 'neutral',
      shade,
    };
  });

  const statusCounts = { valid: 0, grace: 0, unwinding: 0, struck: 0 };
  for (const entry of registry.entries) {
    const status = positionStatus(entry);
    if (status.phase === 'valid') statusCounts.valid += 1;
    else if (status.label === 'IN GRACE') statusCounts.grace += 1;
    else if (status.label === 'UNWINDING') statusCounts.unwinding += 1;
    else statusCounts.struck += 1;
  }
  const reactingCount = statusCounts.grace + statusCounts.unwinding + statusCounts.struck;

  const statusSegments: CompositionSegment[] = [
    { key: 'valid', label: 'Valid', detail: `${statusCounts.valid} position${statusCounts.valid === 1 ? '' : 's'}`, weight: statusCounts.valid, tone: 'neutral' },
    { key: 'grace', label: 'In grace', detail: `${statusCounts.grace} position${statusCounts.grace === 1 ? '' : 's'}`, weight: statusCounts.grace, tone: 'grace' },
    { key: 'unwinding', label: 'Unwinding', detail: `${statusCounts.unwinding} position${statusCounts.unwinding === 1 ? '' : 's'}`, weight: statusCounts.unwinding, tone: 'struck' },
    { key: 'struck', label: 'Struck', detail: `${statusCounts.struck} position${statusCounts.struck === 1 ? '' : 's'}`, weight: statusCounts.struck, tone: 'struck' },
  ];

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
        <div className="pool-liquidity">
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

      <section className="pool-composition">
        <div className="pool-composition__head">
          <p className="eyebrow">Compliance-risk composition</p>
          <p className="notice">
            {registry.entries.length === 0
              ? 'No open positions yet, this view fills in as real borrows and deposits land on chain.'
              : totalOpenDebt > 0n
                ? `${((Number((underCollateralizedDebt * 10_000n) / totalOpenDebt)) / 100).toFixed(1)}% of all outstanding debt sits in positions borrowed below 100% collateral, the pool's real tier-scaled risk, not a hypothetical.`
                : totalCollateral > 0n
                  ? 'Collateral is posted but nothing has been borrowed yet, weighted below by posted collateral rather than debt.'
                  : 'Positions are open with no collateral or debt currently posted.'}
          </p>
          {registry.discovering && (
            <p className="notice" style={{ marginTop: '0.35rem' }}>
              Still scanning chain history for more positions (block {registry.scannedBlock.toLocaleString('en-US')} of{' '}
              {registry.targetBlock.toLocaleString('en-US')}), this composition grows as more real history is found.
            </p>
          )}
        </div>

        <div className="pool-composition__grid">
          <div className="pool-panel">
            <div className="pool-panel__head">
              <h2 className="pool-panel__title">Exposure by tier band</h2>
              <p className="pool-panel__note">Weighted by {weighByDebt ? 'outstanding debt' : 'posted collateral'}</p>
            </div>
            <CompositionBar segments={exposureSegments} emptyLabel="No collateral or debt posted yet" />
            <CompositionLegend segments={exposureSegments} />
          </div>

          <div className="pool-panel">
            <div className="pool-panel__head">
              <h2 className="pool-panel__title">Positions reacting to a compliance change</h2>
              <p className="pool-panel__note">
                {reactingCount === 0 ? 'None right now' : `${reactingCount} of ${registry.entries.length} open`}
              </p>
            </div>
            <CompositionBar segments={statusSegments} emptyLabel="No open positions yet" />
            <CompositionLegend segments={statusSegments} />
          </div>
        </div>
      </section>
    </div>
  );
}
