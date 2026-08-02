/**
 * The keeper's poll loop: for each known borrower, gets an authoritative
 * fact read from an ApassFactSource (either the live Cleanverse sandbox via
 * attestor/attest.ts's cleanverseFactSource, or, for the local anvil
 * rehearsal only, attestor/attest.ts's LocalApassFactSimulator), signs a
 * fresh EIP-712 ComplianceAttestation over those facts (Phase 2b, see
 * contracts/src/ComplianceRegistry.sol's header), relays it on-chain, and
 * drives RevocationGuardian's state machine from the SAME facts' locally
 * computed classification (classifyFromRawFields), one fetch, two uses,
 * no second network/simulator call. Every on-chain write goes through
 * OnChainDriver, which honors dry-run (see onchain.ts).
 */
import type { Address, LocalAccount } from "viem";
import { classifyFromRawFields, type BorrowerClassification } from "./classify.js";
import { GuardianPositionState, type IntendedAction, type OnChainDriver } from "./onchain.js";
import { mapRawFactsToAttestation, type ApassFactSource, type Eip712Domain } from "../attestor/types.js";
import { signAttestation } from "../attestor/sign.js";

export interface PollDeps {
  factSource: ApassFactSource;
  onChain: OnChainDriver;
  poolMinTier: number;
  /** Injectable clock (unix seconds), keeps decision logic AND attestation issuedAt deterministic in tests. */
  now: () => number;
  /** The attestor's signing account (see backend/src/attestor/config.js's ATTESTOR_PRIVATE_KEY). Signing and on-chain relay are deliberately separate, see onchain.ts's header. */
  attestorAccount: LocalAccount;
  domain: Eip712Domain;
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
  const raw = await deps.factSource(address);
  const classification = classifyFromRawFields(raw, address, deps.poolMinTier, deps.now());

  const actionsTaken: IntendedAction[] = [];

  const nonce = await deps.onChain.getNextNonce(address as `0x${string}`);
  const attestation = mapRawFactsToAttestation(raw, address as `0x${string}`, nonce, BigInt(deps.now()));
  const signature = await signAttestation(deps.attestorAccount, deps.domain, attestation);
  const attestAction: IntendedAction = { kind: "submitAttestation", attestation, signature };
  await deps.onChain.execute(attestAction);
  actionsTaken.push(attestAction);

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
