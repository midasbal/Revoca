import type { GasFundingState } from '../hooks/useGasFunding';
import { LiveDot } from './ui/LiveDot';
import { explorerTxUrl, shortHash } from '../chain';

/**
 * Quiet, transient feedback for useGasFunding's point-of-need top-up.
 * Renders nothing once a wallet is known to have enough MON, this is
 * not a permanent chrome element, only a real state actually worth
 * saying something about.
 */
export function GasFundingNotice({ state }: { state: GasFundingState }) {
  if (state.status === 'funding') {
    return (
      <div className="gas-funding-notice" role="status">
        <LiveDot className="gas-funding-notice__dot" />
        <span>Funding testnet gas so you can transact&hellip;</span>
      </div>
    );
  }

  if (state.status === 'funded' && state.gasTxHash) {
    return (
      <div className="gas-funding-notice" role="status">
        <span>
          Testnet gas funded &middot;{' '}
          <a href={explorerTxUrl(state.gasTxHash)} target="_blank" rel="noreferrer">
            {shortHash(state.gasTxHash)}
          </a>
        </span>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="gas-funding-notice gas-funding-notice--error" role="alert">
        <span>Couldn&rsquo;t fund testnet gas: {state.message}</span>
      </div>
    );
  }

  return null;
}
