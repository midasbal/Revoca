import { useMemo, useState } from 'react';
import { formatUnits, parseUnits } from 'viem';
import { Button } from '../ui/Button';

/**
 * One real amount-driven action (post collateral, borrow, withdraw): an
 * input, an optional max, and either an approve step (when the pool's
 * current allowance is short) or the real submit. Shared by every action
 * that doesn't need repay's own full-repay convenience, see RepayAction.
 */
export function AmountAction({
  id,
  label,
  unit,
  max,
  disabled,
  needsApproval,
  allowance,
  approvePending,
  actionPending,
  onApprove,
  onSubmit,
  submitLabel,
  error,
}: {
  id: string;
  label: string;
  unit: string;
  max?: bigint;
  disabled?: boolean;
  needsApproval?: boolean;
  allowance?: bigint;
  approvePending?: boolean;
  actionPending?: boolean;
  onApprove?: (amount: bigint) => void;
  onSubmit: (amount: bigint) => void;
  submitLabel: string;
  error?: string | null;
}) {
  const [value, setValue] = useState('');

  const parsed = useMemo(() => {
    if (!value.trim()) return null;
    try {
      const amount = parseUnits(value, 18);
      return amount > 0n ? amount : null;
    } catch {
      return null;
    }
  }, [value]);

  const exceedsMax = parsed !== null && max !== undefined && parsed > max;
  const invalid = parsed === null || exceedsMax;
  const requiresApproval = Boolean(needsApproval) && parsed !== null && allowance !== undefined && parsed > allowance;
  const busy = Boolean(approvePending) || Boolean(actionPending);

  return (
    <div className="amount-action">
      <div className="amount-action__row">
        <label className="eyebrow" htmlFor={id}>
          {label}
        </label>
        {max !== undefined && (
          <button
            type="button"
            className="amount-action__max"
            disabled={disabled || busy}
            onClick={() => setValue(formatUnits(max, 18))}
          >
            Max {formatUnits(max, 18)}
          </button>
        )}
      </div>
      <div className="amount-action__field">
        <input
          id={id}
          className="input mono"
          inputMode="decimal"
          placeholder="0.0"
          value={value}
          disabled={disabled || busy}
          onChange={(event) => setValue(event.target.value)}
        />
        <span className="amount-action__unit mono">{unit}</span>
        {requiresApproval ? (
          <Button
            variant="ghost"
            disabled={disabled || busy || parsed === null}
            onClick={() => parsed !== null && onApprove?.(parsed)}
          >
            {approvePending ? 'Approving…' : 'Approve'}
          </Button>
        ) : (
          <Button
            disabled={disabled || busy || invalid}
            onClick={() => {
              if (parsed === null) return;
              onSubmit(parsed);
              setValue('');
            }}
          >
            {actionPending ? 'Confirming…' : submitLabel}
          </Button>
        )}
      </div>
      {exceedsMax && <p className="amount-action__status">More than is available.</p>}
      {error && <p className="amount-action__status">{error}</p>}
    </div>
  );
}
