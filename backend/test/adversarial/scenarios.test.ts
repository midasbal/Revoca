/**
 * The adversarial scenario suite: real attacks attempted against a real
 * local deployment, asserted like tests, printing a demo-narratable
 * ATTACK -> PROTOCOL -> STATE trace for each. This is the executable proof
 * behind docs/THREAT_MODEL.md's analysis, every property discussed there
 * (griefing resistance, staleness gating, replay/forgery/domain rejection,
 * the revocation fairness property, live policy re-evaluation) is exercised
 * here as a genuine transaction against genuine contract state, not a
 * unit-level mock.
 *
 * One shared anvil deployment (beforeAll), one fresh funded borrower per
 * scenario (freshFundedBorrower mints its own MockERC20 and sets its own
 * ETH balance, see harness.ts), so scenarios never interfere with each
 * other's compliance/debt state. The one deliberate exception is scenario 7
 * (policy tightening), which is ordered last since it mutates the shared
 * CompliancePolicy for every borrower going forward.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChildProcess } from "node:child_process";
import type { Address } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

import {
  allTraces,
  checkToolsAvailable,
  GRACE_PERIOD_SECONDS,
  GUARDIAN_ABI,
  GUARDIAN_STATE,
  MAX_COMPLIANCE_STALENESS_SECONDS,
  POLICY_ABI,
  POOL_ABI,
  REASON,
  recordTrace,
  REGISTRY_ABI,
  SEED_SUB_TIER,
  SEED_TIER,
  startHarness,
  type Harness,
} from "./harness.js";
import { buildDomain, countryAlpha2ToBytes2, type ComplianceAttestation } from "../../src/attestor/types.js";

const RPC_PORT = 8560; // distinct from every other test file's anvil port

const US = countryAlpha2ToBytes2("US");
const APASS_ACTIVE = 1;
const APASS_FROZEN = 2;

let anvilProcess: ChildProcess | undefined;
let h: Harness;

/** Asserts `promise` rejects with an error whose message names `errorName` (the contract's custom error, e.g. "StaleCompliance"). Returns the error message for the caller to include in a trace line. */
async function assertReverts(promise: Promise<unknown>, errorName: string): Promise<string> {
  let succeeded = false;
  let message = "";
  try {
    await promise;
    succeeded = true;
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  if (succeeded) {
    throw new Error(`expected revert "${errorName}" but the call succeeded`);
  }
  expect(message).toContain(errorName);
  return message;
}

/** Standard active attestation for a fresh borrower: tier/subTier match DeployLocal.s.sol's seed (80% ratio band), country US, issued now. */
async function attestActive(h: Harness, user: Address, opts?: { tier?: number; subTier?: number }): Promise<void> {
  const nonce = await h.nextNonce(user);
  const attestation: ComplianceAttestation = {
    user,
    tier: opts?.tier ?? SEED_TIER,
    subTier: opts?.subTier ?? SEED_SUB_TIER,
    country: US,
    apassStatus: APASS_ACTIVE,
    expiry: 0n,
    issuedAt: h.now(),
    nonce,
  };
  const sig = await h.signAttestation(h.attestorAccount, h.domain, attestation);
  await h.submitAttestation(h.attestorAccount, attestation, sig);
}

async function attestFrozen(h: Harness, user: Address): Promise<void> {
  const nonce = await h.nextNonce(user);
  const attestation: ComplianceAttestation = {
    user,
    tier: SEED_TIER,
    subTier: SEED_SUB_TIER,
    country: US,
    apassStatus: APASS_FROZEN,
    expiry: 0n,
    issuedAt: h.now(),
    nonce,
  };
  const sig = await h.signAttestation(h.attestorAccount, h.domain, attestation);
  await h.submitAttestation(h.attestorAccount, attestation, sig);
}

describe.runIf(checkToolsAvailable())("adversarial scenario suite (anvil)", () => {
  beforeAll(async () => {
    const started = await startHarness(RPC_PORT);
    h = started.harness;
    anvilProcess = started.anvilProcess;
  }, 60_000);

  afterAll(() => {
    anvilProcess?.kill();
  });

  it(
    "Scenario 1: griefing (freeze-to-liquidate) never pays the attacker, and never touches the honest borrower's value",
    async () => {
      const victim = await h.freshFundedBorrower(10_000n * 10n ** 18n);
      await attestActive(h, victim.address);

      await h.walletFor(victim).writeContract({
        address: h.deployment.pool,
        abi: POOL_ABI,
        functionName: "postCollateral",
        args: [2000n * 10n ** 18n],
      });
      await h.walletFor(victim).writeContract({
        address: h.deployment.pool,
        abi: POOL_ABI,
        functionName: "borrow",
        args: [1000n * 10n ** 18n],
      });

      // The "attack": simulate Cleanverse freezing the victim's A-Pass
      // (LOCAL SIMULATION of an external condition, see harness.ts's
      // header; we cannot force a real sandbox freeze), then an attacker
      // (playing the liquidator role) tries to cash in on it immediately.
      await attestFrozen(h, victim.address);

      const attackerClient = h.walletFor(h.liquidatorAccount);
      const balanceBefore = await h.publicClient.readContract({
        address: h.deployment.asset,
        abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }],
        functionName: "balanceOf",
        args: [h.liquidatorAccount.address],
      });

      const msg1 = await assertReverts(
        attackerClient.writeContract({
          address: h.deployment.pool,
          abi: POOL_ABI,
          functionName: "liquidate",
          args: [victim.address],
        }),
        "PositionHealthy",
      );
      recordTrace(
        "attacker calls pool.liquidate(victim) the instant the victim's A-Pass is frozen",
        `reverted: ${msg1.split("\n")[0]}`,
        "a freeze alone never changes the collateral/debt ratio LendingPool.liquidate() checks, tier stays whatever was last attested, so the position is still healthy by the pool's own math",
      );

      // Attacker tries to skip the grace period entirely.
      await h.walletFor(h.deployerAccount).writeContract({
        address: h.deployment.guardian,
        abi: GUARDIAN_ABI,
        functionName: "flag",
        args: [victim.address],
      });
      const msg2 = await assertReverts(
        h.walletFor(h.deployerAccount).writeContract({
          address: h.deployment.guardian,
          abi: GUARDIAN_ABI,
          functionName: "startUnwind",
          args: [victim.address],
        }),
        "GracePeriodNotElapsed",
      );
      recordTrace(
        "flag() succeeds (freeze is real), then an attempt to startUnwind() immediately, skipping the grace period",
        `reverted: ${msg2.split("\n")[0]}`,
        "position is FLAGGED, not UNWINDING, grace period still running, borrower has a real window to be reinstated before anything is at stake",
      );

      // Grace elapses. startUnwind() self-cures first: collateral (2000)
      // comfortably covers debt (~1000 + interest), so the debt is fully
      // settled from the BORROWER'S OWN collateral before liquidate() is
      // even reachable, the attacker never gets a shot at it.
      await h.advanceTime(GRACE_PERIOD_SECONDS + 5);
      await h.walletFor(h.deployerAccount).writeContract({
        address: h.deployment.guardian,
        abi: GUARDIAN_ABI,
        functionName: "startUnwind",
        args: [victim.address],
      });

      const debtAfterSelfCure = await h.publicClient.readContract({
        address: h.deployment.pool,
        abi: POOL_ABI,
        functionName: "currentDebt",
        args: [victim.address],
      });
      expect(debtAfterSelfCure).toBe(0n);

      const msg3 = await assertReverts(
        attackerClient.writeContract({
          address: h.deployment.pool,
          abi: POOL_ABI,
          functionName: "liquidate",
          args: [victim.address],
        }),
        "NoDebt",
      );
      recordTrace(
        "attacker calls pool.liquidate(victim) again once the guardian has run",
        `reverted: ${msg3.split("\n")[0]}`,
        "self-cure already settled the debt from the borrower's own collateral, there is nothing left to liquidate, attacker P&L = 0 (no tokens ever moved to or from the attacker)",
      );

      const balanceAfter = await h.publicClient.readContract({
        address: h.deployment.asset,
        abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }],
        functionName: "balanceOf",
        args: [h.liquidatorAccount.address],
      });
      expect(balanceAfter).toBe(balanceBefore); // attacker's balance is byte-for-byte unchanged

      // Fairness: the victim, still frozen (never re-attested active), can
      // still withdraw every wei of residual collateral, it was never
      // confiscated, only the debt was settled.
      const [residual] = await h.publicClient.readContract({
        address: h.deployment.pool,
        abi: POOL_ABI,
        functionName: "positions",
        args: [victim.address],
      });
      expect(residual).toBeGreaterThan(0n);
      await h.walletFor(victim).writeContract({
        address: h.deployment.pool,
        abi: POOL_ABI,
        functionName: "withdrawCollateral",
        args: [residual],
      });
      recordTrace(
        "victim (still non-compliant, still frozen) withdraws their residual collateral",
        "succeeds",
        `${(Number(residual) / 1e18).toFixed(2)} tokens returned to the still-frozen victim, confirming the griefing attempt cost the attacker nothing and the honest borrower's surplus value was never at risk`,
      );
    },
    60_000,
  );

  it(
    "Scenario 2: a stale attestation blocks risk-increasing actions but never blocks an exit",
    async () => {
      const borrower = await h.freshFundedBorrower(10_000n * 10n ** 18n);
      await attestActive(h, borrower.address);

      await h.walletFor(borrower).writeContract({
        address: h.deployment.pool,
        abi: POOL_ABI,
        functionName: "postCollateral",
        args: [2000n * 10n ** 18n],
      });
      await h.walletFor(borrower).writeContract({
        address: h.deployment.pool,
        abi: POOL_ABI,
        functionName: "borrow",
        args: [500n * 10n ** 18n],
      });
      recordTrace(
        "borrower borrows against a fresh attestation",
        "succeeds",
        "baseline: freshly attested, compliant, well inside the collateral ratio",
      );

      // No new attestation, let the existing one age past maxComplianceStaleness.
      await h.advanceTime(MAX_COMPLIANCE_STALENESS_SECONDS + 60);

      const msgBorrow = await assertReverts(
        h.walletFor(borrower).writeContract({
          address: h.deployment.pool,
          abi: POOL_ABI,
          functionName: "borrow",
          args: [10n * 10n ** 18n],
        }),
        "StaleCompliance",
      );
      recordTrace(
        "borrower attempts another borrow() with their last attestation now older than maxComplianceStaleness",
        `reverted: ${msgBorrow.split("\n")[0]}`,
        "isCompliant() would still report true (the last known facts were ACTIVE), but isFresh() is false, LendingPool.borrow() requires BOTH for any risk-increasing action, stale data is treated as unknown, not as still-good",
      );

      const msgWithdraw = await assertReverts(
        h.walletFor(borrower).writeContract({
          address: h.deployment.pool,
          abi: POOL_ABI,
          functionName: "withdrawCollateral",
          args: [10n * 10n ** 18n],
        }),
        "StaleCompliance",
      );
      recordTrace(
        "borrower attempts withdrawCollateral() (still has open debt) on the same stale attestation",
        `reverted: ${msgWithdraw.split("\n")[0]}`,
        "reducing the collateral cushion behind open debt is risk-increasing too, same staleness gate applies",
      );

      // Risk-decreasing: repay is NEVER gated on freshness.
      await h.walletFor(borrower).writeContract({
        address: h.deployment.pool,
        abi: POOL_ABI,
        functionName: "repay",
        args: [50n * 10n ** 18n],
      });
      recordTrace(
        "borrower repays part of their debt on the same stale attestation",
        "succeeds",
        "repay is risk-decreasing, LendingPool.repay() never checks compliance or freshness at all, a stale attestation can never trap a borrower who wants to pay down debt",
      );

      // The guardian's unwind mechanics (once a position is already
      // flagged) are also not gated on freshness, only flag()/reinstate()
      // are, since those need a recent read to justify their verdict.
      // Separate borrower for a clean flag -> stale -> unwind sequence.
      const borrower2 = await h.freshFundedBorrower(10_000n * 10n ** 18n);
      await attestActive(h, borrower2.address, { tier: SEED_TIER, subTier: SEED_SUB_TIER });
      await h.walletFor(borrower2).writeContract({
        address: h.deployment.pool,
        abi: POOL_ABI,
        functionName: "postCollateral",
        args: [2000n * 10n ** 18n],
      });
      await h.walletFor(borrower2).writeContract({
        address: h.deployment.pool,
        abi: POOL_ABI,
        functionName: "borrow",
        args: [1000n * 10n ** 18n],
      });
      await attestFrozen(h, borrower2.address); // fresh at flag time
      await h.walletFor(h.deployerAccount).writeContract({
        address: h.deployment.guardian,
        abi: GUARDIAN_ABI,
        functionName: "flag",
        args: [borrower2.address],
      });

      // Let BOTH the grace period and staleness elapse with no re-attestation.
      await h.advanceTime(MAX_COMPLIANCE_STALENESS_SECONDS + GRACE_PERIOD_SECONDS + 60);

      await h.walletFor(h.deployerAccount).writeContract({
        address: h.deployment.guardian,
        abi: GUARDIAN_ABI,
        functionName: "startUnwind",
        args: [borrower2.address],
      });
      const debtAfter = await h.publicClient.readContract({
        address: h.deployment.pool,
        abi: POOL_ABI,
        functionName: "currentDebt",
        args: [borrower2.address],
      });
      expect(debtAfter).toBe(0n);
      recordTrace(
        "guardian.startUnwind() runs on a position whose attestation is now stale (long past maxComplianceStaleness)",
        "succeeds, self-cure settles the debt",
        "startUnwind()/completeUnwind() never check isFresh at all, once a position is legitimately flagged the unwind must be able to complete even if the backend goes quiet afterwards",
      );

      // Legitimate recovery path: a fresh attestation restores borrowing on borrower1.
      await attestActive(h, borrower.address);
      await h.walletFor(borrower).writeContract({
        address: h.deployment.pool,
        abi: POOL_ABI,
        functionName: "borrow",
        args: [10n * 10n ** 18n],
      });
      recordTrace(
        "borrower submits a fresh attestation, then retries the same borrow() that was blocked",
        "succeeds",
        "staleness is a live, re-checkable gate, not a permanent penalty, the moment fresh data exists the action is allowed again",
      );
    },
    60_000,
  );

  it(
    "Scenario 3: attestation replay and out-of-order nonces are rejected, a correctly incremented one succeeds",
    async () => {
      const borrower = await h.freshFundedBorrower(1_000n * 10n ** 18n);

      const nonce1 = await h.nextNonce(borrower.address);
      expect(nonce1).toBe(1n);
      const a1: ComplianceAttestation = {
        user: borrower.address,
        tier: SEED_TIER,
        subTier: SEED_SUB_TIER,
        country: US,
        apassStatus: APASS_ACTIVE,
        expiry: 0n,
        issuedAt: h.now(),
        nonce: nonce1,
      };
      const sig1 = await h.signAttestation(h.attestorAccount, h.domain, a1);
      await h.submitAttestation(h.attestorAccount, a1, sig1);
      recordTrace("attestor submits a fresh attestation, nonce 1", "succeeds", "registry stores the facts, lastNonce(borrower) = 1");

      const msgReplay = await assertReverts(h.submitAttestation(h.deployerAccount, a1, sig1), "NonceNotIncreasing");
      recordTrace(
        "attacker captures the (attestation, signature) pair and replays it verbatim",
        `reverted: ${msgReplay.split("\n")[0]}`,
        "submitAttestation requires nonce > lastNonce, resubmitting the SAME nonce (even with a valid signature and identical facts) is rejected",
      );

      const lowerNonceAttestation: ComplianceAttestation = { ...a1, issuedAt: h.now() }; // still nonce 1
      const lowerSig = await h.signAttestation(h.attestorAccount, h.domain, lowerNonceAttestation);
      const msgLower = await assertReverts(
        h.submitAttestation(h.deployerAccount, lowerNonceAttestation, lowerSig),
        "NonceNotIncreasing",
      );
      recordTrace(
        "attacker (or a confused relayer) submits a NEW, validly-signed attestation but reuses nonce 1",
        `reverted: ${msgLower.split("\n")[0]}`,
        "even a fresh, genuinely-attestor-signed message is rejected if its nonce doesn't strictly increase, nonce ordering is enforced independent of signature validity",
      );

      const nonce2 = await h.nextNonce(borrower.address);
      expect(nonce2).toBe(2n);
      const a2: ComplianceAttestation = { ...a1, issuedAt: h.now(), nonce: nonce2 };
      const sig2 = await h.signAttestation(h.attestorAccount, h.domain, a2);
      await h.submitAttestation(h.deployerAccount, a2, sig2);
      recordTrace(
        "attestor issues a correctly incremented attestation, nonce 2, relayed by an unrelated address (submission is permissionless)",
        "succeeds",
        "lastNonce(borrower) = 2, the legitimate path always works, only replay/out-of-order nonces are blocked",
      );
    },
    30_000,
  );

  it(
    "Scenario 4: forged, tampered, and revoked-attestor attestations are all rejected",
    async () => {
      const borrower = await h.freshFundedBorrower(1_000n * 10n ** 18n);

      // (a) Signed by a never-authorized key.
      const impostor = privateKeyToAccount(generatePrivateKey());
      const nonce1 = await h.nextNonce(borrower.address);
      const forged: ComplianceAttestation = {
        user: borrower.address,
        tier: SEED_TIER,
        subTier: SEED_SUB_TIER,
        country: US,
        apassStatus: APASS_ACTIVE,
        expiry: 0n,
        issuedAt: h.now(),
        nonce: nonce1,
      };
      const forgedSig = await h.signAttestation(impostor, h.domain, forged);
      const msgForged = await assertReverts(h.submitAttestation(h.deployerAccount, forged, forgedSig), "NotAuthorizedAttestor");
      recordTrace(
        `an attestation signed by an unauthorized key (${impostor.address.slice(0, 10)}...) claiming borrower is ACTIVE`,
        `reverted: ${msgForged.split("\n")[0]}`,
        "the recovered signer is not in isAttestor, the message is rejected regardless of how convincing its claimed facts are",
      );

      // (b) Validly signed by the real attestor, then tampered before submission.
      const genuine: ComplianceAttestation = { ...forged, issuedAt: h.now() };
      const genuineSig = await h.signAttestation(h.attestorAccount, h.domain, genuine);
      const tampered: ComplianceAttestation = { ...genuine, tier: 90 }; // bumped after signing
      const msgTampered = await assertReverts(h.submitAttestation(h.deployerAccount, tampered, genuineSig), "NotAuthorizedAttestor");
      recordTrace(
        "a genuinely attestor-signed attestation is tampered (tier bumped from 50 to 90) after signing, signature reused as-is",
        `reverted: ${msgTampered.split("\n")[0]}`,
        "the struct hash changes with the facts, so the EIP-712 digest changes too, ECDSA.recover on the tampered struct recovers an unrelated address, not the real attestor, so it fails the same authorization check as an outright forgery",
      );

      // Confirm the untampered original still works.
      await h.submitAttestation(h.deployerAccount, genuine, genuineSig);
      recordTrace("the same attestation submitted untampered, with its original signature", "succeeds", "proves (b) failed because of the tampering, not because the signature itself was somehow invalid");

      // (c) A previously-authorized attestor is revoked, then tries to attest again.
      const rotated = privateKeyToAccount(generatePrivateKey());
      await h.walletFor(h.deployerAccount).writeContract({
        address: h.deployment.registry,
        abi: REGISTRY_ABI,
        functionName: "setAttestor",
        args: [rotated.address, true],
      });
      const rotatedNonce = await h.nextNonce(borrower.address);
      const rotatedAttestation: ComplianceAttestation = { ...forged, issuedAt: h.now(), nonce: rotatedNonce };
      const rotatedSig = await h.signAttestation(rotated, h.domain, rotatedAttestation);
      await h.submitAttestation(h.deployerAccount, rotatedAttestation, rotatedSig);
      recordTrace(`newly authorized attestor (${rotated.address.slice(0, 10)}...) submits an attestation`, "succeeds", "setAttestor(addr, true) takes effect immediately");

      await h.walletFor(h.deployerAccount).writeContract({
        address: h.deployment.registry,
        abi: REGISTRY_ABI,
        functionName: "setAttestor",
        args: [rotated.address, false],
      });
      const revokedNonce = await h.nextNonce(borrower.address);
      const revokedAttestation: ComplianceAttestation = { ...forged, issuedAt: h.now(), nonce: revokedNonce };
      const revokedSig = await h.signAttestation(rotated, h.domain, revokedAttestation);
      const msgRevoked = await assertReverts(h.submitAttestation(h.deployerAccount, revokedAttestation, revokedSig), "NotAuthorizedAttestor");
      recordTrace(
        "owner revokes that attestor (setAttestor(addr, false)), the same key then signs and submits another attestation",
        `reverted: ${msgRevoked.split("\n")[0]}`,
        "revocation is immediate and on-chain, a key that was valid moments ago is rejected the instant isAttestor flips false, no grace window for a revoked key",
      );
    },
    30_000,
  );

  it(
    "Scenario 5: attestations valid under a different domain are rejected by the deployed registry",
    async () => {
      const borrower = await h.freshFundedBorrower(1_000n * 10n ** 18n);
      const nonce = await h.nextNonce(borrower.address);
      const fields = {
        user: borrower.address,
        tier: SEED_TIER,
        subTier: SEED_SUB_TIER,
        country: US,
        apassStatus: APASS_ACTIVE,
        expiry: 0n,
        issuedAt: h.now(),
        nonce,
      };

      const wrongChainDomain = buildDomain(h.domain.chainId + 999, h.deployment.registry);
      const sigWrongChain = await h.signAttestation(h.attestorAccount, wrongChainDomain, fields);
      const msgChain = await assertReverts(
        h.submitAttestation(h.deployerAccount, fields, sigWrongChain),
        "NotAuthorizedAttestor",
      );
      recordTrace(
        `attestation genuinely signed by the real attestor key, but under chainId ${h.domain.chainId + 999} instead of this chain's ${h.domain.chainId}`,
        `reverted: ${msgChain.split("\n")[0]}`,
        "the EIP-712 domain (including chainId) is baked into the digest, a signature valid under one chain's domain recovers to a different address under this registry's actual domain, proving cross-chain replay of an attestation is impossible",
      );

      const wrongContractDomain = buildDomain(h.domain.chainId, h.deployment.pool); // any other real deployed address
      const sigWrongContract = await h.signAttestation(h.attestorAccount, wrongContractDomain, fields);
      const msgContract = await assertReverts(
        h.submitAttestation(h.deployerAccount, fields, sigWrongContract),
        "NotAuthorizedAttestor",
      );
      recordTrace(
        "attestation genuinely signed by the real attestor key, but under verifyingContract = LendingPool's address instead of the registry's",
        `reverted: ${msgContract.split("\n")[0]}`,
        "same mechanism, domain confusion across deployments (or across contracts) is closed by the same EIP-712 domain binding",
      );

      // Baseline: the correct domain works.
      const sigCorrect = await h.signAttestation(h.attestorAccount, h.domain, fields);
      await h.submitAttestation(h.deployerAccount, fields, sigCorrect);
      recordTrace("the identical facts, correctly signed under this registry's real domain", "succeeds", "confirms the two rejections above were specifically about domain confusion, not some unrelated formatting issue");
    },
    30_000,
  );

  it(
    "Scenario 6: a frozen borrower cannot escalate risk, but their residual is never confiscated",
    async () => {
      const borrower = await h.freshFundedBorrower(10_000n * 10n ** 18n);
      await attestActive(h, borrower.address);
      await h.walletFor(borrower).writeContract({
        address: h.deployment.pool,
        abi: POOL_ABI,
        functionName: "postCollateral",
        args: [2000n * 10n ** 18n],
      });
      await h.walletFor(borrower).writeContract({
        address: h.deployment.pool,
        abi: POOL_ABI,
        functionName: "borrow",
        args: [1000n * 10n ** 18n],
      });

      await attestFrozen(h, borrower.address); // fresh, so this is genuine non-compliance, not staleness

      const msgBorrow = await assertReverts(
        h.walletFor(borrower).writeContract({
          address: h.deployment.pool,
          abi: POOL_ABI,
          functionName: "borrow",
          args: [10n * 10n ** 18n],
        }),
        "NotCompliant",
      );
      recordTrace(
        "frozen borrower attempts to draw more debt",
        `reverted: ${msgBorrow.split("\n")[0]}`,
        "isCompliant() is false (apassStatus is FROZEN), borrow() blocks it outright, no new risk can be taken on while non-compliant",
      );

      const msgWithdraw = await assertReverts(
        h.walletFor(borrower).writeContract({
          address: h.deployment.pool,
          abi: POOL_ABI,
          functionName: "withdrawCollateral",
          args: [10n * 10n ** 18n],
        }),
        "NotCompliant",
      );
      recordTrace(
        "frozen borrower attempts to withdraw a small amount of collateral while debt is still open",
        `reverted: ${msgWithdraw.split("\n")[0]}`,
        "withdrawing collateral behind open debt is risk-increasing, blocked the same way, even a small, technically-still-safe amount",
      );

      await h.walletFor(h.deployerAccount).writeContract({
        address: h.deployment.guardian,
        abi: GUARDIAN_ABI,
        functionName: "flag",
        args: [borrower.address],
      });
      const flaggedPos = await h.publicClient.readContract({
        address: h.deployment.guardian,
        abi: GUARDIAN_ABI,
        functionName: "positions",
        args: [borrower.address],
      });
      expect(flaggedPos[1]).toBe(REASON.FROZEN);

      await h.advanceTime(GRACE_PERIOD_SECONDS + 5);
      await h.walletFor(h.deployerAccount).writeContract({
        address: h.deployment.guardian,
        abi: GUARDIAN_ABI,
        functionName: "startUnwind",
        args: [borrower.address],
      });

      const debtAfter = await h.publicClient.readContract({
        address: h.deployment.pool,
        abi: POOL_ABI,
        functionName: "currentDebt",
        args: [borrower.address],
      });
      expect(debtAfter).toBe(0n);
      const [residual] = await h.publicClient.readContract({
        address: h.deployment.pool,
        abi: POOL_ABI,
        functionName: "positions",
        args: [borrower.address],
      });
      expect(residual).toBeGreaterThan(0n);
      recordTrace(
        "guardian.startUnwind() self-cures the debt from the borrower's own collateral",
        "debt settled to 0",
        `${(Number(residual) / 1e18).toFixed(2)} tokens of collateral remain, unspent, this is the borrower's surplus, not the pool's`,
      );

      const guardianPos = await h.publicClient.readContract({
        address: h.deployment.guardian,
        abi: GUARDIAN_ABI,
        functionName: "positions",
        args: [borrower.address],
      });
      expect(guardianPos[0]).toBe(GUARDIAN_STATE.RESOLVED);

      const isCompliantNow = await h.publicClient.readContract({
        address: h.deployment.registry,
        abi: REGISTRY_ABI,
        functionName: "isCompliant",
        args: [borrower.address],
      });
      expect(isCompliantNow).toBe(false); // still frozen, never re-attested

      await h.walletFor(borrower).writeContract({
        address: h.deployment.pool,
        abi: POOL_ABI,
        functionName: "withdrawCollateral",
        args: [residual],
      });
      recordTrace(
        "still-frozen, still-non-compliant borrower withdraws their full residual collateral",
        "succeeds",
        "debt is 0, so withdrawCollateral() no longer gates on compliance or freshness at all, revocation settles what was owed, it is never confiscation of what wasn't",
      );
    },
    60_000,
  );

  it(
    "Scenario 7: tightening the policy flips eligibility live, with no new attestation",
    async () => {
      const borrower = await h.freshFundedBorrower(10_000n * 10n ** 18n);
      await attestActive(h, borrower.address); // tier 50, subTier 80

      const isCompliantBefore = await h.publicClient.readContract({
        address: h.deployment.registry,
        abi: REGISTRY_ABI,
        functionName: "isCompliant",
        args: [borrower.address],
      });
      expect(isCompliantBefore).toBe(true);

      await h.walletFor(borrower).writeContract({
        address: h.deployment.pool,
        abi: POOL_ABI,
        functionName: "postCollateral",
        args: [2000n * 10n ** 18n],
      });
      await h.walletFor(borrower).writeContract({
        address: h.deployment.pool,
        abi: POOL_ABI,
        functionName: "borrow",
        args: [500n * 10n ** 18n],
      });
      recordTrace("borrower borrows under the current policy (minTier 0, no restriction)", "succeeds", "baseline, compliant, tier 50 comfortably clears an unset minTier");

      const minTierBefore = await h.publicClient.readContract({
        address: h.deployment.policy,
        abi: POLICY_ABI,
        functionName: "minTier",
      });
      expect(minTierBefore).toBe(0);

      await h.walletFor(h.deployerAccount).writeContract({
        address: h.deployment.policy,
        abi: POLICY_ABI,
        functionName: "setMinTier",
        args: [60], // above the borrower's attested tier of 50
      });

      const isCompliantAfter = await h.publicClient.readContract({
        address: h.deployment.registry,
        abi: REGISTRY_ABI,
        functionName: "isCompliant",
        args: [borrower.address],
      });
      expect(isCompliantAfter).toBe(false);
      recordTrace(
        "owner raises the pool's minTier from 0 to 60, strictly above the borrower's attested tier of 50, no new attestation submitted anywhere",
        "registry.isCompliant(borrower) flips from true to false immediately",
        "eligibility is derived live from stored facts + the current policy, never cached at attestation time, tightening the policy re-evaluates every existing attestation instantly",
      );

      const msgBorrow = await assertReverts(
        h.walletFor(borrower).writeContract({
          address: h.deployment.pool,
          abi: POOL_ABI,
          functionName: "borrow",
          args: [10n * 10n ** 18n],
        }),
        "NotCompliant",
      );
      recordTrace(
        "borrower (same attestation as before, nothing about their own facts changed) attempts another borrow()",
        `reverted: ${msgBorrow.split("\n")[0]}`,
        "registry.isCompliant() itself folds in policy.isTierEligible(), so borrow() rejects via NotCompliant before it ever reaches its own separate TierNotEligible check, the same attested tier that was fine a moment ago now fails compliance entirely, no forged or stale data involved, the policy itself moved",
      );

      // Bonus: the guardian's flag() path reacts too, no code change needed.
      await h.walletFor(h.deployerAccount).writeContract({
        address: h.deployment.guardian,
        abi: GUARDIAN_ABI,
        functionName: "flag",
        args: [borrower.address],
      });
      const flaggedPos = await h.publicClient.readContract({
        address: h.deployment.guardian,
        abi: GUARDIAN_ABI,
        functionName: "positions",
        args: [borrower.address],
      });
      expect(flaggedPos[0]).toBe(GUARDIAN_STATE.FLAGGED);
      expect(flaggedPos[1]).toBe(REASON.INELIGIBLE);
      recordTrace(
        "guardian.flag(borrower) is called after the policy change",
        "succeeds, reason INELIGIBLE",
        "the same live-derived ineligibility that blocked borrow() is also what the guardian's flag() sees, the whole unwind machinery reacts to a policy change exactly as it would to a real compliance failure, with no special-casing",
      );
    },
    30_000,
  );

  it("prints the full scenario trace summary", () => {
    const traces = allTraces();
    expect(traces.length).toBeGreaterThanOrEqual(7);
    console.log(`\n=== Adversarial scenario suite: ${traces.length} recorded attack -> outcome traces ===\n`);
  });
});
