import { useMemo, useState } from 'react';
import { formatUnits, parseUnits, type Hex } from 'viem';
import { Button } from '../ui/Button';
import { TxStatus } from '../ui/TxStatus';
import type { ActionPhase } from '../../hooks/useBorrowerActions';

const MAX_UINT256 = 2n ** 256n - 1n;

/**
 * Repay is its own component rather than reusing AmountAction: the
 * contract's own convention (`repay(type(uint256).max)` clamps to
 * exactly what's owed, see LendingPool.sol) is the only way to repay in
 * full without leaving interest-accrual dust from the gap between
 * reading a debt figure and the transaction actually landing. "Repay in
 * full" approves generously (the pool only ever pulls what's genuinely
 * owed) and sends the sentinel value directly.
 */
export function RepayAction({
  debt,
  allowance,
  disabled,
  approvePending,
  actionPending,
  phase,
  onApprove,
  onSubmit,
  error,
  success,
}: {
  debt: bigint;
  allowance: bigint;
  disabled?: boolean;
  approvePending?: boolean;
  actionPending?: boolean;
  phase?: ActionPhase | null;
  onApprove: (amount: bigint) => void;
  onSubmit: (amount: bigint) => void;
  error?: string | null;
  success?: Hex | null;
}) {
  const [value, setValue] = useState('');
  const [lastAmount, setLastAmount] = useState<bigint | null>(null);

  const parsed = useMemo(() => {
    if (!value.trim()) return null;
    try {
      const amount = parseUnits(value, 18);
      return amount > 0n ? amount : null;
    } catch {
      return null;
    }
  }, [value]);

  const busy = Boolean(approvePending) || Boolean(actionPending);
  const hasDebt = debt > 0n;

  const partialRequiresApproval = parsed !== null && parsed > allowance;
  const fullRequiresApproval = allowance < debt;

  return (
    <div className="amount-action">
      <div className="amount-action__row">
        <label className="eyebrow" htmlFor="repay-amount">
          Repay
        </label>
        <button type="button" className="amount-action__max" disabled={disabled || busy || !hasDebt} onClick={() => setValue(formatUnits(debt, 18))}>
          Owed {formatUnits(debt, 18)}
        </button>
      </div>
      <div className="amount-action__field">
        <input
          id="repay-amount"
          className="input mono"
          inputMode="decimal"
          placeholder="0.0"
          value={value}
          disabled={disabled || busy}
          onChange={(event) => setValue(event.target.value)}
        />
        <span className="amount-action__unit mono">rtUSD</span>
        {partialRequiresApproval ? (
          <Button variant="ghost" disabled={disabled || busy} onClick={() => parsed !== null && onApprove(parsed)}>
            {approvePending ? (phase === 'signing' ? 'Confirm in wallet…' : 'Approving…') : 'Approve'}
          </Button>
        ) : (
          <Button
            disabled={disabled || busy || parsed === null}
            onClick={() => {
              if (parsed === null) return;
              setLastAmount(parsed);
              onSubmit(parsed);
              setValue('');
            }}
          >
            {actionPending ? (phase === 'signing' ? 'Confirm in wallet…' : 'Submitting…') : 'Repay'}
          </Button>
        )}
      </div>
      <div className="amount-action__row" style={{ marginTop: '0.5rem', marginBottom: 0 }}>
        <p className="amount-action__meta">Or clear it entirely, no rounding dust.</p>
        {fullRequiresApproval ? (
          <Button variant="ghost" disabled={disabled || busy || !hasDebt} onClick={() => onApprove(MAX_UINT256)}>
            {approvePending ? (phase === 'signing' ? 'Confirm in wallet…' : 'Approving…') : 'Approve full repay'}
          </Button>
        ) : (
          <Button
            variant="ghost"
            disabled={disabled || busy || !hasDebt}
            onClick={() => {
              setLastAmount(debt);
              onSubmit(MAX_UINT256);
            }}
          >
            {actionPending ? (phase === 'signing' ? 'Confirm in wallet…' : 'Submitting…') : 'Repay in full'}
          </Button>
        )}
      </div>
      <TxStatus error={error} success={success} successLabel={lastAmount !== null ? `Repaid ${formatUnits(lastAmount, 18)} rtUSD` : 'Repaid'} />
    </div>
  );
}
