import { useEffect, useRef, useState } from 'react';
import type { Address, Hex } from 'viem';
import { useNativeBalance } from './useNativeBalance';
import { fundGas } from '../api/onboarding';

/** Matches the backend's own GAS_TOP_UP_THRESHOLD (backend/src/onboarding/fund.ts), kept in sync manually, the two packages have no shared build step. Below this, a wallet can't reliably send even one transaction on Monad testnet. */
const LOW_BALANCE_THRESHOLD = 3n * 10n ** 17n; // 0.3 MON

export type GasFundingState =
  | { status: 'idle' }
  | { status: 'sufficient' }
  | { status: 'funding' }
  | { status: 'funded'; gasTxHash: Hex | null }
  | { status: 'error'; message: string };

/**
 * Point-of-need gas funding: the moment a connected wallet's own MON
 * balance reads as too low to transact, this fires the real backend
 * fund-gas call automatically, once per address per session, no button
 * to find. Any connected wallet gets this, not only ones that went
 * through borrower onboarding, that gate never applied to lenders, see
 * LendPage.tsx.
 */
export function useGasFunding(address: Address | undefined, active: boolean): GasFundingState {
  const balance = useNativeBalance(active ? address : undefined);
  const [state, setState] = useState<GasFundingState>({ status: 'idle' });
  const attemptedRef = useRef<Address | null>(null);

  useEffect(() => {
    if (!address || balance === null) return;

    if (balance >= LOW_BALANCE_THRESHOLD) {
      if (attemptedRef.current !== address) setState({ status: 'sufficient' });
      return;
    }

    if (attemptedRef.current === address) return; // already tried this address this session, don't retry on every poll tick
    attemptedRef.current = address;

    setState({ status: 'funding' });
    fundGas(address)
      .then((result) => setState({ status: 'funded', gasTxHash: result.gasTxHash }))
      .catch((err) => setState({ status: 'error', message: err instanceof Error ? err.message : String(err) }));
  }, [address, balance]);

  return state;
}
