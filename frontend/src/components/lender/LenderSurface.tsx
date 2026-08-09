import type { Address } from 'viem';
import { AmountAction } from '../borrower/AmountAction';
import { PoolContextRail } from '../borrower/PoolContextRail';
import { LenderNoteRail } from './LenderNoteRail';
import { Button } from '../ui/Button';
import { useLenderActions } from '../../hooks/useLenderActions';
import type { LenderSnapshot } from '../../hooks/useLenderPosition';
import { formatAmount, formatBps, shortAddress } from '../../chain';

const SECONDS_PER_YEAR = 31_536_000n;

/** Matches RTUSD_FUND_AMOUNT, the same amount real borrower onboarding mints (backend/src/onboarding/provision.ts), so either path leaves a wallet with a comparable, meaningful test balance. */
const FAUCET_AMOUNT = 2_000n * 10n ** 18n;

/**
 * The real lender surface: live pool liquidity and utilization, this
 * lender's own share of the pool, and the two real actions (deposit,
 * withdraw) against the deployed LendingPool. Lending is permissionless,
 * LendingPool.deposit() carries no compliance check at all, so unlike
 * the borrower surface there is no onboarding gate here, a connected
 * wallet is all that's needed. Flanked by the same two rails the
 * borrower surface uses, the pool this lender supplies into on the
 * left, what actually protects that capital on the right, so toggling
 * between Borrow and Lend feels like one composed app.
 */
export function LenderSurface({ address, lender }: { address: Address; lender: LenderSnapshot }) {
  const actions = useLenderActions();

  const withdrawable = lender.shareValue > lender.idleLiquidity ? lender.idleLiquidity : lender.shareValue;
  const aprBps = (lender.ratePerSecondBps * SECONDS_PER_YEAR) / 100n;

  return (
    <div className="surface-layout">
      <PoolContextRail variant="lender" />

      <div className="surface-layout__content">
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
            {formatAmount(lender.idleLiquidity)} rtUSD idle &middot; {formatAmount(lender.totalPrincipalOutstanding)} rtUSD out on
            loan
          </p>

          <div className="ruled">
            <span className="eyebrow ruled__label">What you earn</span>
          </div>
          <p className="notice">
            The pool&rsquo;s live borrow rate is <span className="mono">{lender.ratePerSecondBps.toString()} bps/second</span>,
            tuned fast so accrual is observable within a session, not a real-world figure, annualized naively that is{' '}
            <span className="mono">{(Number(aprBps) / 100).toLocaleString('en-US')}%</span>. Interest is realized into the
            pool&rsquo;s value at each borrower&rsquo;s repayment, not continuously, see docs for the exact mechanics.
          </p>
        </div>

        <div className="borrower-card">
          <p className="eyebrow">Wallet</p>
          <p className="notice" style={{ marginTop: '0.5rem' }}>
            <span className="mono">{formatAmount(lender.assetBalance)}</span> rtUSD available to deposit
          </p>

          <div className="action">
            <Button
              variant="ghost"
              disabled={actions.pending !== null}
              onClick={() => void actions.mintTestAsset(address, FAUCET_AMOUNT)}
            >
              {actions.pending === 'mint' ? 'Minting…' : `Get ${formatAmount(FAUCET_AMOUNT)} test rtUSD`}
            </Button>
            <p className="action__status">
              A real on-chain mint, straight to your wallet, no backend involved. rtUSD is a testnet token whose mint is
              intentionally open, never a stand-in for real value.
            </p>
            {actions.pending === null && actions.error && <p className="action__status action__status--error">{actions.error}</p>}
          </div>

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
              Your full share is {formatAmount(lender.shareValue)} rtUSD, but only {formatAmount(lender.idleLiquidity)} rtUSD
              sits idle in the pool right now, the rest is out on loan. Withdrawals are capped by idle liquidity, a real
              constraint, never a fabricated one.
            </p>
          )}
        </div>
      </div>

      <LenderNoteRail />
    </div>
  );
}
