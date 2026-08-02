/**
 * The keeper's poll loop: for each known borrower, gets an authoritative
 * eligibility read from an ApassDataSource (either the live Cleanverse
 * sandbox via cleanverseSource.ts, or, for the local anvil rehearsal only,
 * localSimulator.ts's deterministic in-process stand-in), writes it to
 * ComplianceRegistry, and drives RevocationGuardian's state machine as the
 * observation dictates. Every on-chain write goes through OnChainDriver,
 * which honors dry-run (see onchain.ts). This module doesn't know or care
 * which source it was given, that's the whole point of the
 * ApassDataSource seam.
 */
import type { Address } from "viem";
import { classifyBorrower, type ApassDataSource, type BorrowerClassification } from "./classify.js";
import { GuardianPositionState, type IntendedAction, type OnChainDriver } from "./onchain.js";

export interface PollDeps {
  dataSource: ApassDataSource;
  onChain: OnChainDriver;
  poolMinTier: number;
  /** Injectable clock (unix seconds), keeps decision logic deterministic in tests. */
  now: () => number;
}

export interface BorrowerPollResult {
  classification: BorrowerClassification;
  actionsTaken: IntendedAction[];
}

/**
 * Classifies one borrower and decides what (if anything) to do about it,
 * given the guardian's current on-chain state for that address. Always
 * observes to the registry first (fresh data every cycle), then evaluates
 * state transitions.
 */
export async function pollBorrower(deps: PollDeps, address: Address): Promise<BorrowerPollResult> {
  const classification = await classifyBorrower(deps.dataSource, address, deps.poolMinTier, deps.now());

  const actionsTaken: IntendedAction[] = [];

  const observeAction: IntendedAction = {
    kind: "observeCompliance",
    user: address,
    compliant: classification.compliant,
    tier: classification.tier ?? 0,
    subTier: classification.subTier ?? 0,
    reason: classification.reason,
  };
  await deps.onChain.execute(observeAction);
  actionsTaken.push(observeAction);

  const position = await deps.onChain.getGuardianPosition(address);
  const poolHealthy = await deps.onChain.isPoolHealthy(address);

  switch (position.state) {
    case GuardianPositionState.HEALTHY:
    case GuardianPositionState.RESOLVED: {
      if (!classification.compliant || !poolHealthy) {
        const action: IntendedAction = { kind: "flag", borrower: address };
        await deps.onChain.execute(action);
        actionsTaken.push(action);
      }
      break;
    }
    case GuardianPositionState.FLAGGED: {
      const graceElapsed = BigInt(deps.now()) >= position.graceEndsAt;
      if (classification.compliant && poolHealthy) {
        const action: IntendedAction = { kind: "reinstate", borrower: address };
        await deps.onChain.execute(action);
        actionsTaken.push(action);
      } else if (graceElapsed) {
        const action: IntendedAction = { kind: "startUnwind", borrower: address };
        await deps.onChain.execute(action);
        actionsTaken.push(action);
      }
      break;
    }
    case GuardianPositionState.UNWINDING: {
      const debt = await deps.onChain.currentDebt(address);
      if (debt === 0n) {
        const action: IntendedAction = { kind: "completeUnwind", borrower: address };
        await deps.onChain.execute(action);
        actionsTaken.push(action);
      }
      break;
    }
  }

  return { classification, actionsTaken };
}

/** Runs one full poll cycle over a fixed list of borrower addresses. */
export async function pollOnce(deps: PollDeps, borrowers: Address[]): Promise<BorrowerPollResult[]> {
  const results: BorrowerPollResult[] = [];
  for (const address of borrowers) {
    results.push(await pollBorrower(deps, address));
  }
  return results;
}

/** Starts an interval-based poll loop. Returns a stop function. */
export function startPollLoop(
  deps: PollDeps,
  getBorrowers: () => Promise<Address[]>,
  pollIntervalMs: number,
  onCycle?: (results: BorrowerPollResult[]) => void,
): () => void {
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      const borrowers = await getBorrowers();
      const results = await pollOnce(deps, borrowers);
      onCycle?.(results);
    } catch (err) {
      console.error("Keeper poll cycle failed:", err instanceof Error ? err.message : err);
    } finally {
      if (!stopped) setTimeout(tick, pollIntervalMs);
    }
  };

  void tick();

  return () => {
    stopped = true;
  };
}
