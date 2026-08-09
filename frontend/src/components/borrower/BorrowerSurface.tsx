import { formatEther, type Address } from 'viem';
import { RingMark } from '../RingMark';
import { TickingValue } from '../TickingValue';
import { RatioBandsTable } from './RatioBandsTable';
import { AmountAction } from './AmountAction';
import { RepayAction } from './RepayAction';
import { PoolContextRail } from './PoolContextRail';
import { StandingNoteRail } from './StandingNoteRail';
import type { BorrowerSnapshot } from '../../hooks/useBorrowerStanding';
import type { RatioBandsState } from '../../hooks/useRatioBands';
import { useBorrowerActions } from '../../hooks/useBorrowerActions';
import { useStrikePhase } from '../../hooks/useStrikePhase';
import { useClock } from '../../hooks/useClock';
import { positionStatus } from '../../positionStatus';
import { formatAmount, formatBps, shortAddress, GuardianReason } from '../../chain';

/**
 * The real borrower surface: live standing, the real ratio your tier
 * earns, live position, and the four real actions against the deployed
 * LendingPool. Renders only once `useBorrowerStanding` confirms real
 * standing exists, LendPage swaps this out for OnboardingCard otherwise.
 * Flanked by two rails, the pool this borrower draws against on the
 * left, this position's real standing/unwind status on the right, the
 * same console proportions as the record view, not empty margins.
 */
export function BorrowerSurface({
  address,
  standing,
  bandsState,
}: {
  address: Address;
  standing: BorrowerSnapshot;
  bandsState: RatioBandsState;
}) {
  const now = useClock();
  const status = positionStatus(standing);
  const struck = status.phase === 'struck';
  const { phase, prefersReduced, completeStrike } = useStrikePhase(struck, true);
  const actions = useBorrowerActions();

  const currentRatioBps = standing.debt > 0n ? Number((standing.collateral * 10_000n) / standing.debt) : null;
  const maxDebt = standing.ratioBps > 0 ? (standing.collateral * 10_000n) / BigInt(standing.ratioBps) : 0n;
  const borrowRoom = maxDebt > standing.debt ? maxDebt - standing.debt : 0n;

  return (
    <div className="surface-layout">
      <PoolContextRail />

      <div className="surface-layout__content">
        <div className="borrower-card">
          <div className="record__header">
            <span className="eyebrow">Revoca &middot; Your standing</span>
            <span className="eyebrow record__live">
              <span className="record__live-dot" aria-hidden="true" />
              Live, Monad testnet
            </span>
          </div>

          <div className="seal-band">
            <div className="seal-band__ring">
              <RingMark phase={phase} prefersReduced={prefersReduced} onStrikeComplete={completeStrike} />
            </div>
            <div className="field seal-band__standing">
              <p className="eyebrow field__label">Standing</p>
              <p className={phase === 'struck' ? 'field__value field__value--struck' : 'field__value field__value--valid'}>
                {phase === 'struck' ? 'STRUCK' : 'VALID'}
              </p>
              <p className="field__meta">
                {struck ? (
                  <>
                    Reason: <span className="mono">{GuardianReason[standing.guardianReason] ?? 'UNKNOWN'}</span>
                  </>
                ) : (
                  <>
                    Tier <span className="mono">{standing.tier}</span> / subtier <span className="mono">{standing.subTier}</span>,
                    attested and fresh
                  </>
                )}
              </p>
            </div>
          </div>

          <p className="record__number">
            Borrower <strong className="mono">{shortAddress(address)}</strong>
          </p>

          <div className="stats">
            <div className="stat">
              <p className="eyebrow stat__label">Your ratio</p>
              <p className="stat__value">
                <TickingValue value={formatBps(standing.ratioBps)} />
              </p>
            </div>
            <div className="stat">
              <p className="eyebrow stat__label">Collateral</p>
              <p className="stat__value">
                <TickingValue value={formatAmount(standing.collateral)} />
                <span className="stat__unit">rtUSD</span>
              </p>
            </div>
            <div className="stat">
              <p className="eyebrow stat__label">Debt</p>
              <p className="stat__value">
                <TickingValue value={formatAmount(standing.debt)} />
                <span className="stat__unit">rtUSD</span>
              </p>
            </div>
          </div>

          {currentRatioBps !== null && (
            <p className="notice" style={{ marginTop: '0.75rem' }}>
              Currently collateralized at {formatBps(currentRatioBps)}, {formatBps(standing.ratioBps)} required by your tier.
            </p>
          )}

          <div className="ruled">
            <span className="eyebrow ruled__label">Standing sets the terms</span>
          </div>
          {bandsState.status === 'ready' && (
            <RatioBandsTable bands={bandsState.bands} activeTier={standing.tier} activeSubTier={standing.subTier} />
          )}
          {bandsState.status === 'error' && <p className="notice">Could not read the ratio table: {bandsState.message}</p>}
        </div>

        <div className="borrower-card">
          <p className="eyebrow">Wallet</p>
          <p className="notice" style={{ marginTop: '0.5rem' }}>
            <span className="mono">{formatAmount(standing.assetBalance)}</span> rtUSD &middot;{' '}
            <span className="mono">{formatGas(standing.nativeBalance)}</span> MON for gas
          </p>

          <div className="ruled">
            <span className="eyebrow ruled__label">Post collateral</span>
          </div>
          <AmountAction
            id="post-amount"
            label="Amount"
            unit="rtUSD"
            max={standing.assetBalance}
            needsApproval
            allowance={standing.allowance}
            approvePending={actions.pending === 'approve'}
            actionPending={actions.pending === 'post'}
            onApprove={(amount) => void actions.approve(amount)}
            onSubmit={(amount) => void actions.postCollateral(amount)}
            submitLabel="Post collateral"
            error={actions.pending === null ? actions.error : null}
          />

          <div className="ruled">
            <span className="eyebrow ruled__label">Borrow</span>
          </div>
          <AmountAction
            id="borrow-amount"
            label="Amount"
            unit="rtUSD"
            max={borrowRoom}
            actionPending={actions.pending === 'borrow'}
            onSubmit={(amount) => void actions.borrow(amount)}
            submitLabel="Borrow"
            error={actions.pending === null ? actions.error : null}
          />

          <div className="ruled">
            <span className="eyebrow ruled__label">Repay</span>
          </div>
          <RepayAction
            debt={standing.debt}
            allowance={standing.allowance}
            approvePending={actions.pending === 'approve'}
            actionPending={actions.pending === 'repay'}
            onApprove={(amount) => void actions.approve(amount)}
            onSubmit={(amount) => void actions.repay(amount)}
            error={actions.pending === null ? actions.error : null}
          />

          <div className="ruled">
            <span className="eyebrow ruled__label">Withdraw collateral</span>
          </div>
          <AmountAction
            id="withdraw-amount"
            label="Amount"
            unit="rtUSD"
            max={standing.collateral}
            actionPending={actions.pending === 'withdraw'}
            onSubmit={(amount) => void actions.withdrawCollateral(amount)}
            submitLabel="Withdraw"
            error={actions.pending === null ? actions.error : null}
          />
        </div>
      </div>

      <StandingNoteRail standing={standing} address={address} now={now} />
    </div>
  );
}

/** Gas balances are typically well under 1 MON, formatAmount's whole-number rounding (right for rtUSD amounts) would always show "0". Three decimals is enough to show a real, non-zero funded balance. */
function formatGas(raw: bigint): string {
  return Number(formatEther(raw)).toFixed(3);
}
