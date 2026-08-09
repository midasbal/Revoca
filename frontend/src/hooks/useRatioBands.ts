import { useEffect, useState } from 'react';
import { DEPLOYMENT, POLICY_ABI, publicClient } from '../chain';

export interface RatioBand {
  minTier: number;
  minSubTier: number;
  ratioBps: number;
}

export type RatioBandsState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; bands: RatioBand[] };

const RETRY_DELAY_MS = 3000;

/**
 * Reads CompliancePolicy's real ratio-band table live, never a hardcoded
 * copy of the numbers. Batches every `ratioBandAt` read into one
 * multicall (not N separate requests), Monad's public testnet RPC caps
 * throughput at 15/sec (see chain.ts's header), a handful of borrower
 * reads landing in the same instant is enough to trip that on its own.
 * A transient RPC failure (the same cap, or a dropped request) retries
 * once after a short delay rather than leaving the table stuck in a
 * permanent error state for the rest of the page's life.
 */
export function useRatioBands(): RatioBandsState {
  const [state, setState] = useState<RatioBandsState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    let retryTimer: number | undefined;

    async function load(isRetry: boolean) {
      try {
        const count = await publicClient.readContract({
          address: DEPLOYMENT.policy,
          abi: POLICY_ABI,
          functionName: 'ratioBandCount',
        });
        const bands = await publicClient.multicall({
          contracts: Array.from({ length: Number(count) }, (_, i) => ({
            address: DEPLOYMENT.policy,
            abi: POLICY_ABI,
            functionName: 'ratioBandAt' as const,
            args: [BigInt(i)] as const,
          })),
          allowFailure: false,
        });
        if (!cancelled) {
          setState({
            status: 'ready',
            bands: bands.map(([minTier, minSubTier, ratioBps]) => ({ minTier, minSubTier, ratioBps })),
          });
        }
      } catch (err) {
        if (cancelled) return;
        if (!isRetry) {
          retryTimer = window.setTimeout(() => void load(true), RETRY_DELAY_MS);
          return;
        }
        setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    }

    void load(false);
    return () => {
      cancelled = true;
      window.clearTimeout(retryTimer);
    };
  }, []);

  return state;
}
