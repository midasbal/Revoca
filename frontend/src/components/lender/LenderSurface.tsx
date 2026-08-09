import type { Address } from 'viem';
import { AmountAction } from '../borrower/AmountAction';
import { useLenderActions } from '../../hooks/useLenderActions';
import type { LenderSnapshot } from '../../hooks/useLenderPosition';
import { formatAmount, formatBps, shortAddress } from '../../chain';

const SECONDS_PER_YEAR = 31_536_000n;

/**
 * The real lender surface: live pool liquidity and utilization, this
 * lender's own share of the pool, and the two real actions (deposit,
 * withdraw) against the deployed LendingPool. Lending is permissionless,
 * LendingPool.deposit() carries no compliance check at all, so unlike
 * the borrower surface there is no onboarding gate here, a connected
 * wallet is all that's needed.
 */
export function LenderSurface({ address, lender }: { address: Address; lender: LenderSnapshot }) {
  const actions = useLenderActions();

  const withdrawable = lender.shareValue > lender.idleLiquidity ? lender.idleLiquidity : lender.shareValue;
  const aprBps = (lender.ratePerSecondBps * SECONDS_PER_YEAR) / 100n;

  return (
    <>
      <div className="borrower-card">
        <div className="record__header">
          <span className="eyebrow">Revoca &middot; Pool liquidity</span>
          <span className="eyebrow record__live">
            <span className="record__live-dot" aria-hidden="true" />
            Live, Monad testnet
          </span>
        </div>

        <p className="record__number" style={{ marginTop: 'var(--space-4)' }}>
          Lender <strong className="mono">{shortAddress(address)}</strong>
        </p>

        <div className="stats">
          <div className="stat">
            <p className="eyebrow stat__label">Your share</p>
            <p className="stat__value">
              {formatAmount(lender.shareValue)}
              <span className="stat__unit">rtUSD</span>
            </p>
          </div>
          <div className="stat">
            <p className="eyebrow stat__label">Pool liquidity</p>
            <p className="stat__value">
              {formatAmount(lender.totalPooledAssets)}
              <span className="stat__unit">rtUSD</span>
            </p>
          </div>
          <div className="stat">
            <p className="eyebrow stat__label">Utilization</p>
            <p className="stat__value">{formatBps(lender.utilizationBps)}</p>
          </div>
        </div>

        <p className="notice" style={{ marginTop: '0.75rem' }}>
          {formatAmount(lender.idleLiquidity)} rtUSD idle &middot; {formatAmount(lender.totalPrincipalOutstanding)} rtUSD out on loan
        </p>

        <div className="ruled">
          <span className="eyebrow ruled__label">What you earn</span>
        </div>
        <p className="notice">
          The pool&rsquo;s live borrow rate is <span className="mono">{lender.ratePerSecondBps.toString()} bps/second</span>, tuned fast so
          accrual is observable within a session, not a real-world figure, annualized naively that is{' '}
          <span className="mono">{(Number(aprBps) / 100).toLocaleString('en-US')}%</span>. Interest is realized into the pool&rsquo;s value at
          each borrower&rsquo;s repayment, not continuously, see docs for the exact mechanics.
        </p>
      </div>

      <div className="borrower-card">
        <p className="eyebrow">Wallet</p>
        <p className="notice" style={{ marginTop: '0.5rem' }}>
          <span className="mono">{formatAmount(lender.assetBalance)}</span> rtUSD available to deposit
        </p>

        <div className="ruled">
          <span className="eyebrow ruled__label">Deposit</span>
        </div>
        <AmountAction
          id="deposit-amount"
          label="Amount"
          unit="rtUSD"
          max={lender.assetBalance}
          needsApproval
          allowance={lender.allowance}
          approvePending={actions.pending === 'approve'}
          actionPending={actions.pending === 'deposit'}
          onApprove={(amount) => void actions.approve(amount)}
          onSubmit={(amount) => void actions.deposit(amount)}
          submitLabel="Deposit"
          error={actions.pending === null ? actions.error : null}
        />

        <div className="ruled">
          <span className="eyebrow ruled__label">Withdraw</span>
        </div>
        <AmountAction
          id="withdraw-lender-amount"
          label="Amount"
          unit="rtUSD"
          max={withdrawable}
          actionPending={actions.pending === 'withdraw'}
          onSubmit={(amount) => void actions.withdraw(amount)}
          submitLabel="Withdraw"
          error={actions.pending === null ? actions.error : null}
        />
        {lender.shareValue > lender.idleLiquidity && (
          <p className="notice" style={{ marginTop: '0.5rem' }}>
            Your full share is {formatAmount(lender.shareValue)} rtUSD, but only {formatAmount(lender.idleLiquidity)} rtUSD sits idle in
            the pool right now, the rest is out on loan. Withdrawals are capped by idle liquidity, a real constraint, never a fabricated
            one.
          </p>
        )}
      </div>
    </>
  );
}
