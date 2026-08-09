import { useEffect, useRef, useState } from 'react';
import { DEPLOYMENT, POOL_ABI, publicClient } from '../chain';

export interface PoolSnapshot {
  idleLiquidity: bigint;
  totalPrincipalOutstanding: bigint;
  totalCollateral: bigint;
  totalPooledAssets: bigint;
  utilizationBps: number;
  ratePerSecondBps: bigint;
  polledAt: number;
}

export type PoolState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: PoolSnapshot };

const POLL_INTERVAL_MS = 8000;

/** The pool's own aggregate state, no connected wallet needed, live for anyone looking at pool-wide risk (PoolPage) or lender context. */
export function usePoolState(): PoolState {
  const [state, setState] = useState<PoolState>({ status: 'loading' });
  const generation = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    generation.current += 1;
    const myGeneration = generation.current;

    async function tick() {
      if (inFlight) return;
      inFlight = true;
      try {
        const [idleLiquidity, totalPrincipalOutstanding, totalCollateral, totalPooledAssets, utilizationBps, ratePerSecondBps] =
          await publicClient.multicall({
            contracts: [
              { address: DEPLOYMENT.pool, abi: POOL_ABI, functionName: 'idleLiquidity' },
              { address: DEPLOYMENT.pool, abi: POOL_ABI, functionName: 'totalPrincipalOutstanding' },
              { address: DEPLOYMENT.pool, abi: POOL_ABI, functionName: 'totalCollateral' },
              { address: DEPLOYMENT.pool, abi: POOL_ABI, functionName: 'totalPooledAssets' },
              { address: DEPLOYMENT.pool, abi: POOL_ABI, functionName: 'currentUtilizationBps' },
              { address: DEPLOYMENT.pool, abi: POOL_ABI, functionName: 'currentInterestRateBpsPerSecond' },
            ],
            allowFailure: false,
          });
        if (!cancelled && generation.current === myGeneration) {
          setState({
            status: 'ready',
            data: { idleLiquidity, totalPrincipalOutstanding, totalCollateral, totalPooledAssets, utilizationBps, ratePerSecondBps, polledAt: Date.now() },
          });
        }
      } catch (err) {
        if (!cancelled && generation.current === myGeneration) {
          setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
        }
      } finally {
        inFlight = false;
      }
    }

    void tick();
    const id = window.setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  return state;
}
