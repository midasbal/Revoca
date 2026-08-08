import { useEffect, useRef, useState } from 'react';
import { DEMO_BORROWER } from '../deployment';
import { DEPLOYMENT, GUARDIAN_ABI, POOL_ABI, REGISTRY_ABI, publicClient } from '../chain';

export interface PositionSnapshot {
  collateral: bigint;
  principal: bigint;
  debt: bigint;
  ratioBps: number;
  tier: number;
  subTier: number;
  compliant: boolean;
  fresh: boolean;
  guardianState: number;
  guardianReason: number;
  graceEndsAt: bigint;
  blockTimestamp: bigint;
}

export type PositionState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: PositionSnapshot };

const POLL_INTERVAL_MS = 4000;

/**
 * One batched eth_call via Multicall3 (deployed on Monad testnet,
 * confirmed before relying on it) instead of seven separate
 * readContract requests. Monad's public testnet RPC caps request
 * throughput at 15/sec, confirmed for real this session when the
 * unbatched version of this hook tripped it on a fresh page load, seven
 * parallel reads plus useLedger's own requests landing in the same
 * instant genuinely burst past that.
 */
async function fetchSnapshot(): Promise<PositionSnapshot> {
  const [[position, debt, ratioBps, tierOf, compliant, fresh, guardianPosition], block] = await Promise.all([
    publicClient.multicall({
      contracts: [
        { address: DEPLOYMENT.pool, abi: POOL_ABI, functionName: 'positions', args: [DEMO_BORROWER] },
        { address: DEPLOYMENT.pool, abi: POOL_ABI, functionName: 'currentDebt', args: [DEMO_BORROWER] },
        { address: DEPLOYMENT.pool, abi: POOL_ABI, functionName: 'currentRatioBps', args: [DEMO_BORROWER] },
        { address: DEPLOYMENT.registry, abi: REGISTRY_ABI, functionName: 'tierOf', args: [DEMO_BORROWER] },
        { address: DEPLOYMENT.registry, abi: REGISTRY_ABI, functionName: 'isCompliant', args: [DEMO_BORROWER] },
        { address: DEPLOYMENT.registry, abi: REGISTRY_ABI, functionName: 'isFresh', args: [DEMO_BORROWER] },
        { address: DEPLOYMENT.guardian, abi: GUARDIAN_ABI, functionName: 'positions', args: [DEMO_BORROWER] },
      ],
      allowFailure: false,
    }),
    publicClient.getBlock(),
  ]);

  return {
    collateral: position[0],
    principal: position[1],
    debt,
    ratioBps,
    tier: tierOf[0],
    subTier: tierOf[1],
    compliant,
    fresh,
    guardianState: guardianPosition[0],
    guardianReason: guardianPosition[1],
    graceEndsAt: guardianPosition[3],
    blockTimestamp: block.timestamp,
  };
}

/** Polls the demo borrower's live on-chain standing at a fixed interval. Real reads only, no mock data, an error state surfaces if the RPC can't be reached rather than showing a fabricated value. */
export function usePosition(): PositionState {
  const [state, setState] = useState<PositionState>({ status: 'loading' });
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
        const data = await fetchSnapshot();
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
  }, []);

  return state;
}
