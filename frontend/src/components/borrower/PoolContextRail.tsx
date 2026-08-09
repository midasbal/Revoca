import { usePoolState } from '../../hooks/usePoolState';
import { formatAmount, formatBps } from '../../chain';

const SECONDS_PER_YEAR = 31_536_000n;

/**
 * The left margin on both the borrower and lender surfaces, filled with
 * what it was empty of: the one real pool either side actually deals
 * with. Same live reads PoolPage uses, not a separate model, real
 * numbers or nothing. `variant` only changes the intro line's framing,
 * borrower or lender, the data underneath is identical either way, the
 * same pool.
 */
export function PoolContextRail({ variant = 'borrower' }: { variant?: 'borrower' | 'lender' }) {
  const pool = usePoolState();

  return (
    <aside className="rail rail--pool" aria-label="Pool context">
      <div className="rail__block">
        <p className="eyebrow rail__label">The pool</p>
        <p className="rail__prose">
          {variant === 'borrower'
            ? 'What you borrow against: one shared pool, its liquidity and utilization read live, the same state every borrower and lender sees.'
            : 'What you supply into: one shared pool, its liquidity and utilization read live, the same state every borrower and lender sees.'}
        </p>
      </div>

      {pool.status === 'ready' && (
        <>
          <div className="rail__block">
            <p className="eyebrow rail__label">Pooled liquidity</p>
            <p className="rail__value rail__value--lg mono">{formatAmount(pool.data.totalPooledAssets)}</p>
            <p className="rail__submeta">rtUSD &middot; {formatAmount(pool.data.idleLiquidity)} idle</p>
          </div>
          <div className="rail__block">
            <p className="eyebrow rail__label">Utilization</p>
            <p className="rail__value mono">{formatBps(pool.data.utilizationBps)}</p>
          </div>
          <div className="rail__block">
            <p className="eyebrow rail__label">Borrow rate</p>
            <p className="rail__value mono">{((Number(pool.data.ratePerSecondBps * SECONDS_PER_YEAR) / 100) / 100).toFixed(0)}% APR</p>
            <p className="rail__submeta">Demo-tuned, not a real-world figure</p>
          </div>
        </>
      )}

      {pool.status === 'error' && <p className="rail__submeta">Could not read the pool: {pool.message}</p>}
      {pool.status === 'loading' && <p className="rail__submeta">Reading live pool state&hellip;</p>}
    </aside>
  );
}
