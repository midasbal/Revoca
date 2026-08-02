/**
 * Proves the audit report builder (backend/src/audit/, docs/AUDIT_REPORT.md)
 * against a real local deployment: drives the same kind of scripted
 * sequence as the dress rehearsal (backend/test/e2e-local-rehearsal.test.ts),
 * exercising both unwind branches (self-cure-then-liquidation, and
 * self-cure-only with a genuine residual), then builds a report purely from
 * the resulting on-chain event logs and asserts it matches the known
 * ground truth exactly, that the self-cross-check against live chain state
 * passes, and that a tampered report fails signature verification.
 *
 * Runs its own anvil instance on a dedicated port so it can run alongside
 * e2e-local-rehearsal.test.ts without a port collision.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createTestClient, createWalletClient, http, parseAbi, type Address } from "viem";
import { foundry } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

import { createOnChainDriver } from "../src/keeper/onchain.js";
import { pollBorrower } from "../src/keeper/poller.js";
import type { KeeperConfig } from "../src/keeper/config.js";
import { LocalApassFactSimulator } from "../src/attestor/attest.js";
import { buildDomain } from "../src/attestor/types.js";
import { buildAuditReport } from "../src/audit/reconstruct.js";
import { hashReport, signReport, verifyReport } from "../src/audit/sign.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACTS_DIR = resolve(REPO_ROOT, "../contracts");
const DEPLOYMENT_PATH = resolve(REPO_ROOT, "../deployments/local.json");
const RPC_PORT = 8557;
const RPC_URL = `http://127.0.0.1:${RPC_PORT}`;

const ATTESTOR_PK_FALLBACK = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6" as const;
const LIQUIDATOR_PK = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba" as const;
const BORROWER3_PK = "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e" as const;

const SEED_TIER = 50;
const SEED_SUB_TIER = 80;
const GRACE_PERIOD_SECONDS = 60;

const POOL_ABI = parseAbi([
  "function liquidate(address borrower) external",
  "function positions(address) external view returns (uint256 collateral, uint256 principal, uint256 accruedInterest, uint256 lastAccrualTimestamp)",
  "function currentDebt(address) external view returns (uint256)",
  "function withdrawCollateral(uint256 amount) external",
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

let anvilProcess: ChildProcess | undefined;
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

describe.runIf(checkToolsAvailable())("audit report builder (anvil)", () => {
  beforeAll(async () => {
    anvilProcess = spawn("anvil", ["--port", String(RPC_PORT)], { stdio: "ignore" });
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
    "reconstructs both unwind branches exactly, self-cross-checks, and detects tampering",
    async () => {
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

      // fromBlock is 0, not "the block when this test starts driving
      // events": DeployLocal.s.sol already seeded borrower1/2/3's
      // CollateralPosted/Borrow events during deployment, before this test
      // does anything. A real audit report is built from genesis (or the
      // pool's deployment block), it must see those seed events too, not
      // just the events this test happens to trigger afterwards.
      const startBlock = 0n;

      // Branch A, borrower1: freeze -> flag -> reinstate during grace.
      simulator.freeze(deployment.borrower1, SEED_TIER, SEED_SUB_TIER, "US");
      await pollBorrower(pollDeps, deployment.borrower1);
      simulator.setActive(deployment.borrower1, SEED_TIER, SEED_SUB_TIER, "US");
      await pollBorrower(pollDeps, deployment.borrower1);

      // Branch B, borrower2: freeze -> flag -> grace elapses -> unwind ->
      // self-cure insufficient -> liquidation spillover -> resolved.
      simulator.freeze(deployment.borrower2, SEED_TIER, SEED_SUB_TIER, "US");
      await pollBorrower(pollDeps, deployment.borrower2);

      // Branch B', borrower3: freeze -> flag -> grace elapses -> unwind ->
      // self-cure alone covers debt -> resolved with genuine residual.
      simulator.freeze(deployment.borrower3, SEED_TIER, SEED_SUB_TIER, "US");
      await pollBorrower(pollDeps, deployment.borrower3);

      await testClient.increaseTime({ seconds: GRACE_PERIOD_SECONDS + 5 });
      await testClient.mine({ blocks: 1 });
      simulatedNow += GRACE_PERIOD_SECONDS + 5;

      await pollBorrower(pollDeps, deployment.borrower2); // startUnwind, self-cure insufficient
      const liquidateHash = await liquidatorClient.writeContract({
        address: deployment.pool,
        abi: POOL_ABI,
        functionName: "liquidate",
        args: [deployment.borrower2],
      });
      await publicClient.waitForTransactionReceipt({ hash: liquidateHash });
      await pollBorrower(pollDeps, deployment.borrower2); // completeUnwind

      await pollBorrower(pollDeps, deployment.borrower3); // startUnwind, resolves immediately, residual left

      const residual3 = (
        await publicClient.readContract({
          address: deployment.pool,
          abi: POOL_ABI,
          functionName: "positions",
          args: [deployment.borrower3],
        })
      )[0];
      expect(residual3).toBeGreaterThan(0n);

      const borrower3Client = createWalletClient({
        account: privateKeyToAccount(BORROWER3_PK),
        chain: foundry,
        transport: http(RPC_URL),
      });
      const withdrawHash = await borrower3Client.writeContract({
        address: deployment.pool,
        abi: POOL_ABI,
        functionName: "withdrawCollateral",
        args: [residual3],
      });
      await publicClient.waitForTransactionReceipt({ hash: withdrawHash });

      const endBlock = await publicClient.getBlockNumber();

      // ---------------------------------------------------------------
      // Build the report purely from events in [startBlock, endBlock].
      // ---------------------------------------------------------------
      const report = await buildAuditReport({
        publicClient,
        pool: deployment.pool,
        fromBlock: startBlock,
        toBlock: endBlock,
      });

      // Ground truth: guardian states reconstructed exactly right.
      const byBorrower = new Map(report.positions.map((p) => [p.borrower.toLowerCase(), p]));
      const p1 = byBorrower.get(deployment.borrower1.toLowerCase())!;
      const p2 = byBorrower.get(deployment.borrower2.toLowerCase())!;
      const p3 = byBorrower.get(deployment.borrower3.toLowerCase())!;

      expect(p1.reconstructed.guardianState).toBe("HEALTHY");
      expect(p2.reconstructed.guardianState).toBe("RESOLVED");
      expect(p3.reconstructed.guardianState).toBe("RESOLVED");

      // Branch B: liquidation spillover happened, residual is 0 (self-cure
      // drained all collateral before liquidation ran).
      expect(p2.unwinds).toHaveLength(1);
      expect(p2.unwinds[0]!.liquidation).toBeDefined();
      expect(p2.unwinds[0]!.completedAt!.residualCollateral.raw).toBe("0");
      expect(p2.timeline.some((t) => t.type === "Liquidate")).toBe(true);

      // Branch B': self-cure alone resolved it, no liquidation, genuine
      // residual that was then withdrawn (collateral back to 0 after).
      expect(p3.unwinds).toHaveLength(1);
      expect(p3.unwinds[0]!.liquidation).toBeUndefined();
      expect(BigInt(p3.unwinds[0]!.completedAt!.residualCollateral.raw)).toBeGreaterThan(0n);
      expect(p3.reconstructed.collateral.raw).toBe("0"); // withdrawn after resolution

      // Branch A: reinstated, never unwound.
      expect(p1.unwinds).toHaveLength(1);
      expect(p1.unwinds[0]!.reinstatedAt).toBeDefined();
      expect(p1.unwinds[0]!.unwindStarted).toBeUndefined();

      // -----------------------------------------------------------------
      // Self-cross-check: reconstructed state matches live on-chain state
      // exactly, for every position, to the wei.
      // -----------------------------------------------------------------
      expect(report.crossCheckOk).toBe(true);
      for (const p of report.positions) {
        expect(p.crossCheckOk, JSON.stringify(p.crossCheckDiscrepancies)).toBe(true);
        expect(p.reconstructed.debtAsOfReport.raw).toBe(p.onChain.debtAsOfReport.raw);
        expect(p.reconstructed.collateral.raw).toBe(p.onChain.collateral.raw);
        expect(p.reconstructed.guardianState).toBe(p.onChain.guardianState);
      }

      // Penny-exactness: borrower1's on-chain currentDebt() (fresh RPC
      // read, includes interest accrued up to `endBlock`) must equal what
      // the report's projection computed, to the wei.
      const liveDebt1 = await publicClient.readContract({
        address: deployment.pool,
        abi: POOL_ABI,
        functionName: "currentDebt",
        args: [deployment.borrower1],
        blockNumber: endBlock,
      });
      expect(p1.reconstructed.debtAsOfReport.raw).toBe(liveDebt1.toString());

      // -----------------------------------------------------------------
      // Signing: a tampered report must fail verification.
      // -----------------------------------------------------------------
      const signed = await signReport(attestorAccount, report);
      const verifyOk = await verifyReport(signed, attestorAccount.address);
      expect(verifyOk.hashMatches).toBe(true);
      expect(verifyOk.signatureValid).toBe(true);
      expect(verifyOk.signerMatchesExpected).toBe(true);

      const tamperedReport = JSON.parse(JSON.stringify(report));
      tamperedReport.aggregate.totalResidualCollateralReturned.raw = "999999999999999999999999";
      const tampered = { ...signed, report: tamperedReport };
      const verifyTampered = await verifyReport(tampered, attestorAccount.address);
      expect(verifyTampered.hashMatches).toBe(false);
      expect(verifyTampered.signatureValid).toBe(false);

      // Sanity: hashing is deterministic (same report -> same hash twice).
      expect(hashReport(report)).toBe(hashReport(JSON.parse(JSON.stringify(report))));
    },
    120_000,
  );
});
