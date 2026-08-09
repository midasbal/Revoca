import { useEffect, useRef, useState } from 'react';
import type { Address } from 'viem';
import { ASSET_ABI, DEPLOYMENT, GATE_ABI, POOL_ABI, REGISTRY_ABI, publicClient } from '../chain';

export interface BorrowerSnapshot {
  /** What `borrow()` actually checks: the pool's real gate (HybridComplianceGate), not ComplianceRegistry directly, see docs/ARCHITECTURE.md's hybrid design. */
  compliant: boolean;
  fresh: boolean;
  hasStanding: boolean;
  tier: number;
  subTier: number;
  collateral: bigint;
  principal: bigint;
  debt: bigint;
  /** The real tier-derived ratio (bps) this borrower's own standing earns, straight from the pool (which reads CompliancePolicy live). 0 if no debt has ever been computed against a real tier yet, still meaningful once compliant. */
  ratioBps: number;
  assetBalance: bigint;
  allowance: bigint;
  nativeBalance: bigint;
  blockTimestamp: bigint;
  polledAt: number;
}

export type BorrowerStandingState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: BorrowerSnapshot };

const POLL_INTERVAL_MS = 4000;

async function fetchSnapshot(address: Address): Promise<BorrowerSnapshot> {
  const [[compliant, fresh, tierOf, position, debt, ratioBps, assetBalance, allowance], nativeBalance, block] = await Promise.all([
    publicClient.multicall({
      contracts: [
        { address: DEPLOYMENT.gate, abi: GATE_ABI, functionName: 'isCompliant', args: [address] },
        { address: DEPLOYMENT.gate, abi: GATE_ABI, functionName: 'isFresh', args: [address] },
        { address: DEPLOYMENT.registry, abi: REGISTRY_ABI, functionName: 'tierOf', args: [address] },
        { address: DEPLOYMENT.pool, abi: POOL_ABI, functionName: 'positions', args: [address] },
        { address: DEPLOYMENT.pool, abi: POOL_ABI, functionName: 'currentDebt', args: [address] },
        { address: DEPLOYMENT.pool, abi: POOL_ABI, functionName: 'currentRatioBps', args: [address] },
        { address: DEPLOYMENT.asset, abi: ASSET_ABI, functionName: 'balanceOf', args: [address] },
        { address: DEPLOYMENT.asset, abi: ASSET_ABI, functionName: 'allowance', args: [address, DEPLOYMENT.pool] },
      ],
      allowFailure: false,
    }),
    publicClient.getBalance({ address }),
    publicClient.getBlock(),
  ]);

  return {
    compliant,
    fresh,
    hasStanding: compliant && fresh,
    tier: tierOf[0],
    subTier: tierOf[1],
    collateral: position[0],
    principal: position[1],
    debt,
    ratioBps,
    assetBalance,
    allowance,
    nativeBalance,
    blockTimestamp: block.timestamp,
    polledAt: Date.now(),
  };
}

/** Polls a connected borrower's live on-chain standing and position, real reads only. The signal that decides between the onboarding step and the borrower surface. */
export function useBorrowerStanding(address: Address | undefined): BorrowerStandingState {
  const [state, setState] = useState<BorrowerStandingState>({ status: 'loading' });
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
