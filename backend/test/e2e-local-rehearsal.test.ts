/**
 * The dress rehearsal: proves Revoca's full loop closes on a real (local)
 * chain, deployed contracts, a real keeper signing+relaying real EIP-712
 * attestations, a position actually unwinding, end to end. Compliance
 * signal comes from ComplianceRegistry's real Design-B attestation path
 * (Phase 2b, see contracts/src/ComplianceRegistry.sol's header), fed by
 * LocalApassFactSimulator, a LOCAL SIMULATION ONLY stand-in for "Cleanverse
 * changed this borrower's A-Pass state" (see attestor/attest.ts's header).
 * The real sandbox classification/attestation path (cleanverseSource.ts /
 * cleanverseFactSource, keeper-dry-run.integration.test.ts) is untouched by
 * anything in this file.
 *
 * This test:
 *   1. Spawns a real `anvil` instance.
 *   2. Runs contracts/script/DeployLocal.s.sol against it (real deploy txs).
 *   3. Drives the REAL keeper code (classifyBorrower + pollBorrower from
 *      backend/src/keeper) against the deployed contracts via a real
 *      viem wallet, every on-chain write is a genuine transaction, mined
 *      by anvil, confirmed via waitForTransactionReceipt.
 *   4. Exercises three borrower scenarios in parallel against the ONE
 *      shared deployment (see DeployLocal.s.sol's header for why three,
 *      not two, `applyCollateralToDebt` always drains ALL collateral when
 *      self-cure is insufficient, so "self-cure insufficient" and "nonzero
 *      residual after" cannot co-occur in one scenario):
 *
 *     Branch A (borrower1): frozen -> flagged -> reinstated during grace.
 *     Branch B (borrower2): frozen -> flagged -> grace elapses -> unwind ->
 *       self-cure insufficient (debt > collateral) -> spills to
 *       permissionless liquidation -> resolved. Residual is 0 here, that's
 *       correct, not a gap; see Branch B'.
 *     Branch B' (borrower3): frozen -> flagged -> grace elapses -> unwind ->
 *       self-cure alone fully covers debt (collateral > debt) -> resolved
 *       immediately, no liquidation -> nonzero residual, recoverable by the
 *       still-non-compliant borrower.
 *
 * Requires `anvil` and `forge` on PATH (already used throughout this repo's
 * Forge test suite). Skipped automatically if anvil isn't available.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  parseAbi,
  type Address,
  type Log,
} from "viem";
import { foundry } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

import { createOnChainDriver, GuardianPositionState } from "../src/keeper/onchain.js";
import { pollBorrower } from "../src/keeper/poller.js";
import { EligibilityReason } from "../src/keeper/eligibility.js";
import type { KeeperConfig } from "../src/keeper/config.js";
import { LocalApassFactSimulator } from "../src/attestor/attest.js";
import { buildDomain } from "../src/attestor/types.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CONTRACTS_DIR = resolve(REPO_ROOT, "contracts");
const DEPLOYMENT_PATH = resolve(REPO_ROOT, "deployments/local.json");
const RPC_PORT = 8555;
const RPC_URL = `http://127.0.0.1:${RPC_PORT}`;

// Anvil's public, well-known default dev-account keys (mnemonic
// "test test test ... junk", printed by every `anvil` invocation), hold
// no real value. Matches contracts/script/DeployLocal.s.sol exactly. This
// same account plays BOTH the attestor (EIP-712 signer, authorized via
// DeployLocal.s.sol's `setAttestor`) and the keeper (tx relayer, since
// `submitAttestation` is permissionless, see onchain.ts's header) roles in
// this rehearsal. A real deployment would use two separate keys, see
// docs/THREAT_MODEL.md's key-separation guidance.
const ATTESTOR_PK_FALLBACK = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6" as const;
const LIQUIDATOR_PK = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba" as const;

const SEED_TIER = 50;
const SEED_SUB_TIER = 80;
const GRACE_PERIOD_SECONDS = 60; // matches DeployLocal.s.sol's GRACE_PERIOD

const LIQUIDATOR_POOL_ABI = parseAbi([
  "function liquidate(address borrower) external",
  "function positions(address) external view returns (uint256 collateral, uint256 principal, uint256 accruedInterest, uint256 lastAccrualTimestamp)",
  "function currentDebt(address) external view returns (uint256)",
]);

const EVENT_ABI = parseAbi([
  "event ComplianceAttested(address indexed user, uint16 tier, uint16 subTier, bytes2 country, uint8 apassStatus, uint256 expiry, uint256 issuedAt, uint256 nonce, address indexed attestor)",
  "event PositionFlagged(address indexed borrower, uint8 reason, uint256 graceEndsAt)",
  "event PositionReinstated(address indexed borrower)",
  "event UnwindStarted(address indexed borrower, uint256 debtAtStart, uint256 collateralAtStart)",
  "event UnwindStep(address indexed borrower, string step, uint256 amount, uint256 remainingDebt)",
  "event UnwindCompleted(address indexed borrower, uint256 residualCollateral)",
  "event Liquidate(address indexed borrower, address indexed liquidator, uint256 debtRepaid, uint256 collateralSeized, uint256 remainingCollateral)",
]);

interface Deployment {
  asset: Address;
  registry: Address;
  pool: Address;
  guardian: Address;
  deployer: Address;
  lender: Address;
  borrower1: Address;
  borrower2: Address;
  borrower3: Address;
  attestor: Address;
  liquidator: Address;
}

interface CapturedEvent {
  name: string;
  args: Record<string, unknown>;
}

let anvilProcess: ChildProcess | undefined;
let anvilAvailable = true;
let deployment: Deployment;

async function waitForRpc(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`anvil did not become ready at ${url} within ${timeoutMs}ms`);
}

function checkToolsAvailable(): boolean {
  try {
    execSync("anvil --version", { stdio: "ignore" });
    execSync("forge --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.runIf(checkToolsAvailable())("end-to-end local rehearsal (anvil)", () => {
  beforeAll(async () => {
    anvilProcess = spawn("anvil", ["--port", String(RPC_PORT)], { stdio: "ignore" });
    anvilProcess.on("error", () => {
      anvilAvailable = false;
    });

    await waitForRpc(RPC_URL, 15_000);

    execSync(`forge script script/DeployLocal.s.sol --rpc-url ${RPC_URL} --broadcast`, {
      cwd: CONTRACTS_DIR,
      stdio: "pipe",
    });

    if (!existsSync(DEPLOYMENT_PATH)) {
      throw new Error(`Expected ${DEPLOYMENT_PATH} to exist after running DeployLocal.s.sol`);
    }
    deployment = JSON.parse(readFileSync(DEPLOYMENT_PATH, "utf8")) as Deployment;
  }, 60_000);

  afterAll(() => {
    anvilProcess?.kill();
  });

  it(
    "closes the full loop: under-collateralized borrow, freeze, flag, reinstate (Branch A), unwind + liquidation spillover (Branch B), unwind with residual (Branch B')",
    async () => {
      // cacheTime: 0, see onchain.ts's identical comment: without it,
      // getBlockNumber() returns a stale cached value across the many
      // blocks anvil mines within this test's short wall-clock time.
      const publicClient = createPublicClient({ transport: http(RPC_URL), cacheTime: 0 });
      const testClient = createTestClient({ chain: foundry, mode: "anvil", transport: http(RPC_URL) });
      const liquidatorClient = createWalletClient({
        account: privateKeyToAccount(LIQUIDATOR_PK),
        chain: foundry,
        transport: http(RPC_URL),
      });

      const attestorPk = (process.env["LOCAL_KEEPER_PRIVATE_KEY"] || ATTESTOR_PK_FALLBACK) as `0x${string}`;
      const attestorAccount = privateKeyToAccount(attestorPk);

      const keeperConfig: KeeperConfig = {
        poolMinTier: 20,
        pollIntervalMs: 0,
        chain: "local-simulation",
        registryAddress: deployment.registry,
        guardianAddress: deployment.guardian,
        poolAddress: deployment.pool,
        keeperPrivateKey: attestorPk,
      };

      const onChain = createOnChainDriver(keeperConfig, false, { rpcUrl: RPC_URL, chain: foundry });
      const domain = buildDomain(await publicClient.getChainId(), deployment.registry);

      const simulator = new LocalApassFactSimulator();
      // Seed the simulator to match what DeployLocal.s.sol already wrote
      // on-chain directly, the keeper's first poll should be a
      // consistent re-attestation, not a surprise change.
      simulator.setActive(deployment.borrower1, SEED_TIER, SEED_SUB_TIER, "US");
      simulator.setActive(deployment.borrower2, SEED_TIER, SEED_SUB_TIER, "US");
      simulator.setActive(deployment.borrower3, SEED_TIER, SEED_SUB_TIER, "US");

      let simulatedNow = Math.floor(Date.now() / 1000);
      const pollDeps = {
        factSource: simulator.asFactSource(),
        onChain,
        poolMinTier: 20,
        now: () => simulatedNow,
        attestorAccount,
        domain,
      };

      let fromBlock = await publicClient.getBlockNumber();
      const events: CapturedEvent[] = [];

      async function captureNewEvents(): Promise<void> {
        const toBlock = await publicClient.getBlockNumber();
        if (toBlock < fromBlock) return;
        const logs = (await publicClient.getLogs({
          events: EVENT_ABI,
          fromBlock,
          toBlock,
        })) as (Log & { eventName?: string; args?: Record<string, unknown> })[];
        for (const log of logs) {
          if (log.eventName) events.push({ name: log.eventName, args: log.args ?? {} });
        }
        fromBlock = toBlock + 1n;
      }

      // -----------------------------------------------------------------
      // Step 1, prove under-collateralization: initial state, all three
      // borrowers healthy with debt > collateral (borrower1/2) or a
      // comfortably-collateralized position (borrower3).
      // -----------------------------------------------------------------
      const [pos1Before, debt1Before] = await Promise.all([
        publicClient.readContract({
          address: deployment.pool,
          abi: LIQUIDATOR_POOL_ABI,
          functionName: "positions",
          args: [deployment.borrower1],
        }),
        publicClient.readContract({
          address: deployment.pool,
          abi: LIQUIDATOR_POOL_ABI,
          functionName: "currentDebt",
          args: [deployment.borrower1],
        }),
      ]);
      expect(debt1Before).toBeGreaterThan(pos1Before[0]); // debt > collateral
      expect((await onChain.getGuardianPosition(deployment.borrower1)).state).toBe(GuardianPositionState.HEALTHY);
      expect(await onChain.isPoolHealthy(deployment.borrower1)).toBe(true); // under-collateralized but within the 80% ratio -> healthy

      // -----------------------------------------------------------------
      // Step 2, simulate Cleanverse freezing borrower1 and borrower2.
      // Keeper observes, writes on-chain, flags both.
      // -----------------------------------------------------------------
      simulator.freeze(deployment.borrower1, SEED_TIER, SEED_SUB_TIER, "US");
      simulator.freeze(deployment.borrower2, SEED_TIER, SEED_SUB_TIER, "US");

      const poll1 = await pollBorrower(pollDeps, deployment.borrower1);
      const poll2 = await pollBorrower(pollDeps, deployment.borrower2);
      await captureNewEvents();

      expect(poll1.classification.compliant).toBe(false);
      expect(poll1.classification.reason).toBe(EligibilityReason.FROZEN);
      expect(poll1.actionsTaken.map((a) => a.kind)).toEqual(["submitAttestation", "flag"]);
      expect(poll2.actionsTaken.map((a) => a.kind)).toEqual(["submitAttestation", "flag"]);

      const pos1AfterFlag = await onChain.getGuardianPosition(deployment.borrower1);
      expect(pos1AfterFlag.state).toBe(GuardianPositionState.FLAGGED);
      expect(pos1AfterFlag.reason).toBe(EligibilityReason.FROZEN);

      const flaggedEvents = events.filter((e) => e.name === "PositionFlagged");
      expect(flaggedEvents).toHaveLength(2);
      expect(flaggedEvents.every((e) => e.args["reason"] === EligibilityReason.FROZEN)).toBe(true);

      // -----------------------------------------------------------------
      // Branch A, borrower1: compliance restored DURING grace -> reinstate.
      // -----------------------------------------------------------------
      simulator.setActive(deployment.borrower1, SEED_TIER, SEED_SUB_TIER, "US");
      const reinstatePoll = await pollBorrower(pollDeps, deployment.borrower1);
      await captureNewEvents();

      expect(reinstatePoll.actionsTaken.map((a) => a.kind)).toEqual(["submitAttestation", "reinstate"]);
      const pos1AfterReinstate = await onChain.getGuardianPosition(deployment.borrower1);
      expect(pos1AfterReinstate.state).toBe(GuardianPositionState.HEALTHY);

      const [pos1Final, debt1Final] = await Promise.all([
        publicClient.readContract({
          address: deployment.pool,
          abi: LIQUIDATOR_POOL_ABI,
          functionName: "positions",
          args: [deployment.borrower1],
        }),
        publicClient.readContract({
          address: deployment.pool,
          abi: LIQUIDATOR_POOL_ABI,
          functionName: "currentDebt",
          args: [deployment.borrower1],
        }),
      ]);
      expect(pos1Final[0]).toBe(pos1Before[0]); // collateral untouched
      expect(debt1Final).toBeGreaterThanOrEqual(debt1Before); // debt only grew from accrued interest, never force-reduced
      expect(events.some((e) => e.name === "PositionReinstated")).toBe(true);

      // -----------------------------------------------------------------
      // Branch B, borrower2: freeze borrower3 too (for Branch B'), then
      // let grace elapse for borrower2 and borrower3 without reinstating.
      // -----------------------------------------------------------------
      simulator.freeze(deployment.borrower3, SEED_TIER, SEED_SUB_TIER, "US");
      const poll3 = await pollBorrower(pollDeps, deployment.borrower3);
      await captureNewEvents();
      expect(poll3.actionsTaken.map((a) => a.kind)).toEqual(["submitAttestation", "flag"]);

      await testClient.increaseTime({ seconds: GRACE_PERIOD_SECONDS + 5 });
      await testClient.mine({ blocks: 1 });
      simulatedNow += GRACE_PERIOD_SECONDS + 5;

      // borrower2: grace elapsed, still non-compliant -> startUnwind.
      const unwind2 = await pollBorrower(pollDeps, deployment.borrower2);
      await captureNewEvents();
      expect(unwind2.actionsTaken.map((a) => a.kind)).toEqual(["submitAttestation", "startUnwind"]);

      const pos2AfterUnwindStart = await onChain.getGuardianPosition(deployment.borrower2);
      const debt2AfterSelfCure = await publicClient.readContract({
        address: deployment.pool,
        abi: LIQUIDATOR_POOL_ABI,
        functionName: "currentDebt",
        args: [deployment.borrower2],
      });
      const pos2Onchain = await publicClient.readContract({
        address: deployment.pool,
        abi: LIQUIDATOR_POOL_ABI,
        functionName: "positions",
        args: [deployment.borrower2],
      });

      // Self-cure ran FIRST (UnwindStarted then UnwindStep("self-cure", ...) before any Liquidate event exists).
      const unwindStartedIdx = events.findIndex((e) => e.name === "UnwindStarted" && e.args["borrower"] === deployment.borrower2);
      const selfCureStepIdx = events.findIndex(
        (e) => e.name === "UnwindStep" && e.args["borrower"] === deployment.borrower2 && e.args["step"] === "self-cure",
      );
      expect(unwindStartedIdx).toBeGreaterThanOrEqual(0);
      expect(selfCureStepIdx).toBeGreaterThan(unwindStartedIdx);

      // Self-cure was INSUFFICIENT (debt > collateral at seed time) -> all
      // collateral consumed, debt remains, still UNWINDING (not resolved yet).
      expect(pos2Onchain[0]).toBe(0n); // collateral fully drained by self-cure
      expect(debt2AfterSelfCure).toBeGreaterThan(0n); // debt remains
      expect(pos2AfterUnwindStart.state).toBe(GuardianPositionState.UNWINDING);

      // Now permissionlessly liquidate the remainder (anyone may call this
      // directly against the pool, not something the keeper does).
      const liquidateHash = await liquidatorClient.writeContract({
        address: deployment.pool,
        abi: LIQUIDATOR_POOL_ABI,
        functionName: "liquidate",
        args: [deployment.borrower2],
      });
      await publicClient.waitForTransactionReceipt({ hash: liquidateHash });
      await captureNewEvents();

      const debt2AfterLiquidation = await publicClient.readContract({
        address: deployment.pool,
        abi: LIQUIDATOR_POOL_ABI,
        functionName: "currentDebt",
        args: [deployment.borrower2],
      });
      expect(debt2AfterLiquidation).toBe(0n);

      // Keeper's next poll sees debt cleared -> completeUnwind.
      const complete2 = await pollBorrower(pollDeps, deployment.borrower2);
      await captureNewEvents();
      expect(complete2.actionsTaken.map((a) => a.kind)).toEqual(["submitAttestation", "completeUnwind"]);

      const pos2Final = await onChain.getGuardianPosition(deployment.borrower2);
      expect(pos2Final.state).toBe(GuardianPositionState.RESOLVED);

      const residual2 = (
        await publicClient.readContract({
          address: deployment.pool,
          abi: LIQUIDATOR_POOL_ABI,
          functionName: "positions",
          args: [deployment.borrower2],
        })
      )[0];
      // Residual is 0 here, self-cure consumed all collateral before
      // liquidation ever ran, so there was nothing left for liquidation to
      // seize either. Correct, expected behavior (see this file's header
      // and DeployLocal.s.sol's comment), NOT the fairness-property
      // demonstration; that's Branch B' below, with a genuine residual.
      expect(residual2).toBe(0n);

      // -----------------------------------------------------------------
      // Branch B', borrower3: grace already elapsed (warped above).
      // Self-cure alone should fully cover debt (collateral > debt) ->
      // resolved immediately, no liquidation, genuine residual left.
      // -----------------------------------------------------------------
      const unwind3 = await pollBorrower(pollDeps, deployment.borrower3);
      await captureNewEvents();
      expect(unwind3.actionsTaken.map((a) => a.kind)).toEqual(["submitAttestation", "startUnwind"]);

      const pos3Final = await onChain.getGuardianPosition(deployment.borrower3);
      expect(pos3Final.state).toBe(GuardianPositionState.RESOLVED); // resolved WITHIN startUnwind, no separate completeUnwind needed

      const debt3Final = await publicClient.readContract({
        address: deployment.pool,
        abi: LIQUIDATOR_POOL_ABI,
        functionName: "currentDebt",
        args: [deployment.borrower3],
      });
      expect(debt3Final).toBe(0n);

      const residual3 = (
        await publicClient.readContract({
          address: deployment.pool,
          abi: LIQUIDATOR_POOL_ABI,
          functionName: "positions",
          args: [deployment.borrower3],
        })
      )[0];
      expect(residual3).toBeGreaterThan(0n); // genuine, nonzero residual

      // No Liquidate event for borrower3, self-cure alone was sufficient.
      expect(events.some((e) => e.name === "Liquidate" && e.args["borrower"] === deployment.borrower3)).toBe(false);

      // Fairness property: borrower3 is STILL non-compliant per the
      // registry (never re-observed as compliant after the freeze), yet
      // can freely withdraw their residual collateral, debt is 0, so
      // LendingPool.withdrawCollateral never gates on compliance/freshness.
      expect(await onChain.getGuardianPosition(deployment.borrower3)).toMatchObject({
        state: GuardianPositionState.RESOLVED,
      });
      const borrower3Account = privateKeyToAccount(
        "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
      );
      const borrower3Client = createWalletClient({ account: borrower3Account, chain: foundry, transport: http(RPC_URL) });
      const withdrawHash = await borrower3Client.writeContract({
        address: deployment.pool,
        abi: parseAbi(["function withdrawCollateral(uint256 amount) external"]),
        functionName: "withdrawCollateral",
        args: [residual3],
      });
      await publicClient.waitForTransactionReceipt({ hash: withdrawHash });

      const residual3AfterWithdraw = (
        await publicClient.readContract({
          address: deployment.pool,
          abi: LIQUIDATOR_POOL_ABI,
          functionName: "positions",
          args: [deployment.borrower3],
        })
      )[0];
      expect(residual3AfterWithdraw).toBe(0n);

      // -----------------------------------------------------------------
      // Print the full audit trail for the summary.
      // -----------------------------------------------------------------
      console.log("\n=== Full on-chain event sequence (end-to-end rehearsal) ===");
      for (const e of events) {
        console.log(`  ${e.name}(${JSON.stringify(e.args, (_k, v) => (typeof v === "bigint" ? v.toString() : v))})`);
      }
    },
    120_000,
  );
});
