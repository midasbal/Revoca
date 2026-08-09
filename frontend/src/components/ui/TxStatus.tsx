import type { Hex } from 'viem';
import { explorerTxUrl, shortHash } from '../../chain';

/**
 * The one shared success/failure line every real write action shows: a
 * real tx hash linked to the explorer on success, or the wagmi/viem error
 * message on failure. Never both at once, the caller clears success the
 * moment a new attempt starts (see useBorrowerActions/useLenderActions).
 */
export function TxStatus({ success, successLabel, error }: { success?: Hex | null; successLabel?: string; error?: string | null }) {
  if (error) {
    return (
      <p className="amount-action__status amount-action__status--error" role="alert">
        {isRejection(error) ? 'Rejected: ' : 'Transaction failed: '}
        {error}
      </p>
    );
  }
  if (success) {
    return (
      <p className="amount-action__status amount-action__status--success" role="status">
        {successLabel ?? 'Confirmed'} &middot;{' '}
        <a href={explorerTxUrl(success)} target="_blank" rel="noreferrer">
          {shortHash(success)}
        </a>
      </p>
    );
  }
  return null;
}

function isRejection(message: string): boolean {
  return /reject|denied|user cancel/i.test(message);
}
