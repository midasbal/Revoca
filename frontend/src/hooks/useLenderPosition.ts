import { useEffect, useRef, useState } from 'react';
import type { Address } from 'viem';
import { ASSET_ABI, DEPLOYMENT, POOL_ABI, publicClient } from '../chain';

export interface LenderSnapshot {
  shares: bigint;
  totalShares: bigint;
  /** This lender's current claim, in asset terms, at the pool's live value, see LendingPool.shareValue. */
  shareValue: bigint;
  idleLiquidity: bigint;
  totalPrincipalOutstanding: bigint;
  totalPooledAssets: bigint;
  utilizationBps: number;
  /** Raw per-second bps, the pool's own unit, see LendingPool.sol's curve header. Demo-tuned fast for observable accrual within a session, not a real-world rate, see PoolPage's own framing. */
  ratePerSecondBps: bigint;
  assetBalance: bigint;
  allowance: bigint;
  polledAt: number;
}

export type LenderPositionState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: LenderSnapshot };

const POLL_INTERVAL_MS = 4000;

async function fetchSnapshot(address: Address): Promise<LenderSnapshot> {
  const [shares, totalShares, shareValue, idleLiquidity, totalPrincipalOutstanding, totalPooledAssets, utilizationBps, ratePerSecondBps, assetBalance, allowance] =
    await publicClient.multicall({
      contracts: [
        { address: DEPLOYMENT.pool, abi: POOL_ABI, functionName: 'sharesOf', args: [address] },
        { address: DEPLOYMENT.pool, abi: POOL_ABI, functionName: 'totalShares' },
        { address: DEPLOYMENT.pool, abi: POOL_ABI, functionName: 'shareValue', args: [address] },
        { address: DEPLOYMENT.pool, abi: POOL_ABI, functionName: 'idleLiquidity' },
        { address: DEPLOYMENT.pool, abi: POOL_ABI, functionName: 'totalPrincipalOutstanding' },
        { address: DEPLOYMENT.pool, abi: POOL_ABI, functionName: 'totalPooledAssets' },
        { address: DEPLOYMENT.pool, abi: POOL_ABI, functionName: 'currentUtilizationBps' },
        { address: DEPLOYMENT.pool, abi: POOL_ABI, functionName: 'currentInterestRateBpsPerSecond' },
        { address: DEPLOYMENT.asset, abi: ASSET_ABI, functionName: 'balanceOf', args: [address] },
        { address: DEPLOYMENT.asset, abi: ASSET_ABI, functionName: 'allowance', args: [address, DEPLOYMENT.pool] },
      ],
      allowFailure: false,
    });

  return {
    shares,
    totalShares,
    shareValue,
    idleLiquidity,
    totalPrincipalOutstanding,
    totalPooledAssets,
    utilizationBps,
    ratePerSecondBps,
    assetBalance,
    allowance,
    polledAt: Date.now(),
  };
}

/** Polls a connected lender's live pool position and the pool's own live liquidity/utilization state, real reads only. */
export function useLenderPosition(address: Address | undefined): LenderPositionState {
  const [state, setState] = useState<LenderPositionState>({ status: 'loading' });
  const generation = useRef(0);

  useEffect(() => {
    if (!address) {
      setState({ status: 'loading' });
      return;
    }

    let cancelled = false;
    let inFlight = false;
    generation.current += 1;
    const myGeneration = generation.current;
    setState({ status: 'loading' });

    async function tick() {
      if (inFlight || !address) return;
      inFlight = true;
      try {
        const data = await fetchSnapshot(address);
        if (!cancelled && generation.current === myGeneration) {
          setState({ status: 'ready', data });
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
  }, [address]);

  return state;
}
