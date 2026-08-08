/**
 * REAL Monad testnet + real Cleanverse UAT sandbox, full position
 * lifecycle, every step a real transaction, no mock data. Uses the
 * subTier-80 borrower (TESTNET_BORROWER_HIGH_PRIVATE_KEY, tier 50, subTier
 * 80, 80% collateral ratio band) against the current deployment
 * (deployments/testnet.json), redeployed this session specifically so the
 * pool carries the utilization-based interest curve.
 *
 * Phases, run with a `--phase` argument so each can be retried
 * independently against real, possibly-slow testnet confirmation:
 *   borrow   : submit a real pre-borrow attestation (seeds the tier/
 *              subTier ITierOracle needs for the correct 80% ratio band),
 *              resend the collateral post that never landed earlier this
 *              session, then a real borrow().
 *   freeze   : real update_status (freeze) against the real sandbox,
 *              re-read query_apass, submit a second real attestation
 *              reflecting the frozen facts, report whether
 *              complianceVerify itself also flips.
 *   flag     : guardian.flag(borrower), permissionless, real tx. Prints
 *              graceEndsAt.
 *   unwind   : (call once block.timestamp >= graceEndsAt, see
 *              testnet-wait-for-grace.ts) startUnwind (self-cure), then,
 *              if still unhealthy, liquidate() from a funded liquidator,
 *              then completeUnwind(), then attempts withdrawCollateral for
 *              any residual.
 *
 * Run with: npx tsx scripts/testnet-full-lifecycle.ts --phase <name>
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createPublicClient, createWalletClient, http, parseAbi, type Address, type Hex } from "viem";
import { monadTestnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { config as loadDotenv } from "dotenv";

import { loadConfig } from "../src/cleanverse/config.js";
import { CleanverseClient } from "../src/cleanverse/client.js";
import { CleanverseApiError, CleanverseTransportError, CleanverseResponseShapeError } from "../src/cleanverse/errors.js";
import { attest, cleanverseFactSource } from "../src/attestor/attest.js";
import { createAttestationRelay } from "../src/attestor/relay.js";
import { buildDomain } from "../src/attestor/types.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
loadDotenv({ path: resolve(REPO_ROOT, ".env") });

const VALIDATOR_ADDRESS = "0xaC7e5179C2C7f03f209136886c172eb34F161792" as const satisfies Address;
const VALIDATOR_READ_ABI = parseAbi([
  "function complianceVerify(address poolAddress, address userAddress) external view returns (bool)",
]);
const ERC20_ABI = parseAbi([
  "function mint(address to, uint256 amount) external",
  "function approve(address spender, uint256 value) external returns (bool)",
]);
const POOL_ABI = parseAbi([
  "function postCollateral(uint256 amount) external",
  "function borrow(uint256 amount) external",
  "function liquidate(address borrower) external",
  "function withdrawCollateral(uint256 amount) external",
  "function currentDebt(address) external view returns (uint256)",
  "function currentRatioBps(address) external view returns (uint16)",
  "function isHealthy(address) external view returns (bool)",
  "function positions(address) external view returns (uint256 collateral, uint256 principal, uint256 accruedInterest, uint256 lastAccrualTimestamp)",
]);
const GUARDIAN_ABI = parseAbi([
  "function flag(address borrower) external",
  "function startUnwind(address borrower) external",
  "function completeUnwind(address borrower) external",
  "function positions(address) external view returns (uint8 state, uint8 reason, uint256 graceEndsAt)",
]);
const REGISTRY_ABI = parseAbi([
  "function isCompliant(address user) external view returns (bool)",
  "function isFresh(address user) external view returns (bool)",
]);

const COLLATERAL_AMOUNT = 1000n * 10n ** 18n;
const BORROW_AMOUNT = 1200n * 10n ** 18n;
const LENDER_DEPOSIT = 500_000n * 10n ** 18n;

function reportCleanverseError(label: string, err: unknown): void {
  if (err instanceof CleanverseApiError) {
    console.log(`  ${label}: API ERROR code=${err.code} message=${JSON.stringify(err.apiMessage)} request-id=${err.requestId}`);
  } else if (err instanceof CleanverseTransportError) {
    console.log(`  ${label}: TRANSPORT ERROR status=${err.status} ${err.statusText} request-id=${err.requestId}`);
  } else if (err instanceof CleanverseResponseShapeError) {
    console.log(`  ${label}: RESPONSE SHAPE ERROR request-id=${err.requestId} ${err.message}`);
  } else {
    console.log(`  ${label}: UNEXPECTED ERROR ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function loadContext() {
  const deployments = JSON.parse(readFileSync(resolve(REPO_ROOT, "deployments/testnet.json"), "utf8")) as {
    asset: Address;
    pool: Address;
    registry: Address;
    guardian: Address;
  };
  const rpcUrl = process.env["MONAD_TESTNET_RPC"]!;
  const deployerPk = process.env["DEPLOYER_PRIVATE_KEY"] as Hex;
  const borrowerPk = process.env["TESTNET_BORROWER_HIGH_PRIVATE_KEY"] as Hex;
  const attestorPk = process.env["ATTESTOR_PRIVATE_KEY"] as Hex;

  const deployer = privateKeyToAccount(deployerPk);
  const borrower = privateKeyToAccount(borrowerPk);
  const attestor = privateKeyToAccount(attestorPk);

  const publicClient = createPublicClient({ chain: monadTestnet, transport: http(rpcUrl) });
  const deployerWallet = createWalletClient({ account: deployer, chain: monadTestnet, transport: http(rpcUrl) });
  const borrowerWallet = createWalletClient({ account: borrower, chain: monadTestnet, transport: http(rpcUrl) });

  return { deployments, rpcUrl, deployer, borrower, attestor, publicClient, deployerWallet, borrowerWallet };
}

async function send(publicClient: ReturnType<typeof createPublicClient>, label: string, hash: Hex) {
  console.log(`  ${label} tx: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
  console.log(`  ${label} status: ${receipt.status}, block ${receipt.blockNumber}`);
  return receipt;
}

async function submitRealAttestation(ctx: Awaited<ReturnType<typeof loadContext>>, label: string) {
  const client = new CleanverseClient(loadConfig());
  const factSource = cleanverseFactSource(client, "monad");
  const chainId = await ctx.publicClient.getChainId();
  const relay = createAttestationRelay({ rpcUrl: ctx.rpcUrl, chain: monadTestnet, registryAddress: ctx.deployments.registry });
  const domain = buildDomain(chainId, ctx.deployments.registry);

  const raw = await factSource(ctx.borrower.address);
  console.log(`  ${label} real facts from query_apass: ${JSON.stringify(raw)}`);

  const { attestation, signature } = await attest(
    {
      factSource,
      getNextNonce: relay.getNextNonce,
      now: () => Math.floor(Date.now() / 1000),
      account: ctx.attestor,
      domain,
    },
    ctx.borrower.address,
  );

  const hash = await relay.submit(ctx.attestor, attestation, signature);
  await send(ctx.publicClient, `submitAttestation (${label})`, hash);
  return attestation;
}

async function phaseBorrow(ctx: Awaited<ReturnType<typeof loadContext>>) {
  console.log("\n=== PHASE: borrow ===");

  console.log("\n-- Lender deposit --");
  let hash = await ctx.deployerWallet.writeContract({
    address: ctx.deployments.asset,
    abi: ERC20_ABI,
    functionName: "mint",
    args: [ctx.deployer.address, LENDER_DEPOSIT],
    gas: 300_000n,
  });
  await send(ctx.publicClient, "mint(lender)", hash);

  hash = await ctx.deployerWallet.writeContract({
    address: ctx.deployments.asset,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [ctx.deployments.pool, LENDER_DEPOSIT],
    gas: 300_000n,
  });
  await send(ctx.publicClient, "approve(pool, deposit)", hash);

  const POOL_DEPOSIT_ABI = parseAbi(["function deposit(uint256 amount) external"]);
  hash = await ctx.deployerWallet.writeContract({
    address: ctx.deployments.pool,
    abi: POOL_DEPOSIT_ABI,
    functionName: "deposit",
    args: [LENDER_DEPOSIT],
    gas: 300_000n,
  });
  await send(ctx.publicClient, "deposit", hash);

  console.log("\n-- Pre-borrow real attestation (seeds tier=50/subTier=80 for the 80% ratio band) --");
  await submitRealAttestation(ctx, "pre-borrow");

  console.log("\n-- Fund borrower, mint collateral --");
  const borrowerBalance = await ctx.publicClient.getBalance({ address: ctx.borrower.address });
  if (borrowerBalance < 5n * 10n ** 16n) {
    hash = await ctx.deployerWallet.sendTransaction({ to: ctx.borrower.address, value: 5n * 10n ** 16n, gas: 100_000n });
    await send(ctx.publicClient, "fund borrower MON", hash);
  } else {
    console.log("  borrower already funded with enough MON");
  }

  hash = await ctx.deployerWallet.writeContract({
    address: ctx.deployments.asset,
    abi: ERC20_ABI,
    functionName: "mint",
    args: [ctx.borrower.address, COLLATERAL_AMOUNT],
    gas: 300_000n,
  });
  await send(ctx.publicClient, "mint(borrower collateral)", hash);

  console.log("\n-- Borrower posts collateral (resend of the tx that never landed earlier this session) --");
  hash = await ctx.borrowerWallet.writeContract({
    address: ctx.deployments.asset,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [ctx.deployments.pool, COLLATERAL_AMOUNT],
    gas: 300_000n,
  });
  await send(ctx.publicClient, "approve(pool, collateral)", hash);

  hash = await ctx.borrowerWallet.writeContract({
    address: ctx.deployments.pool,
    abi: POOL_ABI,
    functionName: "postCollateral",
    args: [COLLATERAL_AMOUNT],
    gas: 300_000n,
  });
  await send(ctx.publicClient, "postCollateral", hash);

  console.log("\n-- Borrower borrows (real, expected to succeed at the 80% ratio) --");
  const ratioBefore = await ctx.publicClient.readContract({
    address: ctx.deployments.pool,
    abi: POOL_ABI,
    functionName: "currentRatioBps",
    args: [ctx.borrower.address],
  });
  console.log(`  currentRatioBps(borrower) = ${ratioBefore} (expect 8000, the 80% band)`);

  hash = await ctx.borrowerWallet.writeContract({
    address: ctx.deployments.pool,
    abi: POOL_ABI,
    functionName: "borrow",
    args: [BORROW_AMOUNT],
    gas: 400_000n,
  });
  await send(ctx.publicClient, "borrow", hash);

  const debt = await ctx.publicClient.readContract({
    address: ctx.deployments.pool,
    abi: POOL_ABI,
    functionName: "currentDebt",
    args: [ctx.borrower.address],
  });
  console.log(`  currentDebt(borrower) = ${debt.toString()}`);
}

async function phaseFreeze(ctx: Awaited<ReturnType<typeof loadContext>>) {
  console.log("\n=== PHASE: freeze ===");

  const client = new CleanverseClient(loadConfig());

  console.log("\n-- complianceVerify BEFORE freeze --");
  const before = await ctx.publicClient.readContract({
    address: VALIDATOR_ADDRESS,
    abi: VALIDATOR_READ_ABI,
    functionName: "complianceVerify",
    args: [ctx.deployments.pool, ctx.borrower.address],
  });
  console.log(`  complianceVerify(pool, borrower) BEFORE freeze = ${before}`);

  console.log("\n-- update_status (real freeze mutation) --");
  try {
    const result = await client.updateStatus({
      cvRecordId: "1320", // the real cvRecordId from this wallet's generate_apass response
      status: "2",
      wallet: { chain: "monad", address: ctx.borrower.address },
    });
    console.log(`  update_status: SUCCESS ${JSON.stringify(result)}`);
  } catch (err) {
    reportCleanverseError("update_status", err);
    throw err;
  }

  console.log("\n-- Re-read query_apass after freeze --");
  const afterFacts = await client.queryApass({ chain: "monad", address: ctx.borrower.address });
  console.log(`  query_apass AFTER freeze: ${JSON.stringify(afterFacts)}`);

  console.log("\n-- complianceVerify AFTER freeze --");
  try {
    const after = await ctx.publicClient.readContract({
      address: VALIDATOR_ADDRESS,
      abi: VALIDATOR_READ_ABI,
      functionName: "complianceVerify",
      args: [ctx.deployments.pool, ctx.borrower.address],
    });
    console.log(`  complianceVerify(pool, borrower) AFTER freeze = ${after}`);
  } catch (err) {
    console.log(`  complianceVerify AFTER freeze REVERTED: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  }

  console.log("\n-- Post-freeze real attestation (this is what the guardian actually reacts to) --");
  await submitRealAttestation(ctx, "post-freeze");

  const compliant = await ctx.publicClient.readContract({
    address: ctx.deployments.registry,
    abi: REGISTRY_ABI,
    functionName: "isCompliant",
    args: [ctx.borrower.address],
  });
  const fresh = await ctx.publicClient.readContract({
    address: ctx.deployments.registry,
    abi: REGISTRY_ABI,
    functionName: "isFresh",
    args: [ctx.borrower.address],
  });
  console.log(`  registry.isCompliant(borrower) = ${compliant} (expect false)`);
  console.log(`  registry.isFresh(borrower) = ${fresh} (expect true)`);
}

async function phaseFlag(ctx: Awaited<ReturnType<typeof loadContext>>) {
  console.log("\n=== PHASE: flag ===");
  const hash = await ctx.deployerWallet.writeContract({
    address: ctx.deployments.guardian,
    abi: GUARDIAN_ABI,
    functionName: "flag",
    args: [ctx.borrower.address],
    gas: 400_000n,
  });
  await send(ctx.publicClient, "flag", hash);

  const pos = await ctx.publicClient.readContract({
    address: ctx.deployments.guardian,
    abi: GUARDIAN_ABI,
    functionName: "positions",
    args: [ctx.borrower.address],
  });
  console.log(`  guardian position: state=${pos[0]} reason=${pos[1]} graceEndsAt=${pos[2]}`);
  const block = await ctx.publicClient.getBlock();
  console.log(`  current block timestamp: ${block.timestamp}, grace remaining: ${Number(pos[2]) - Number(block.timestamp)}s`);
}

async function phaseUnwind(ctx: Awaited<ReturnType<typeof loadContext>>) {
  console.log("\n=== PHASE: unwind ===");

  const posBefore = await ctx.publicClient.readContract({
    address: ctx.deployments.guardian,
    abi: GUARDIAN_ABI,
    functionName: "positions",
    args: [ctx.borrower.address],
  });
  console.log(`  guardian position before startUnwind: state=${posBefore[0]} reason=${posBefore[1]} graceEndsAt=${posBefore[2]}`);

  let hash = await ctx.deployerWallet.writeContract({
    address: ctx.deployments.guardian,
    abi: GUARDIAN_ABI,
    functionName: "startUnwind",
    args: [ctx.borrower.address],
    gas: 500_000n,
  });
  await send(ctx.publicClient, "startUnwind", hash);

  const posAfterStart = await ctx.publicClient.readContract({
    address: ctx.deployments.guardian,
    abi: GUARDIAN_ABI,
    functionName: "positions",
    args: [ctx.borrower.address],
  });
  console.log(`  guardian position after startUnwind: state=${posAfterStart[0]} reason=${posAfterStart[1]}`);

  const debtAfterSelfCure = await ctx.publicClient.readContract({
    address: ctx.deployments.pool,
    abi: POOL_ABI,
    functionName: "currentDebt",
    args: [ctx.borrower.address],
  });
  const positionAfterSelfCure = await ctx.publicClient.readContract({
    address: ctx.deployments.pool,
    abi: POOL_ABI,
    functionName: "positions",
    args: [ctx.borrower.address],
  });
  console.log(`  debt after self-cure: ${debtAfterSelfCure.toString()}, collateral remaining: ${positionAfterSelfCure[0].toString()}`);

  if (Number(posAfterStart[0]) === 2 /* UNWINDING, self-cure insufficient */ && debtAfterSelfCure > 0n) {
    console.log("\n-- Self-cure insufficient, liquidating (real, permissionless) --");
    hash = await ctx.deployerWallet.writeContract({
      address: ctx.deployments.asset,
      abi: ERC20_ABI,
      functionName: "mint",
      args: [ctx.deployer.address, debtAfterSelfCure + 10n ** 18n],
      gas: 300_000n,
    });
    await send(ctx.publicClient, "mint(liquidator funds)", hash);

    hash = await ctx.deployerWallet.writeContract({
      address: ctx.deployments.asset,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [ctx.deployments.pool, debtAfterSelfCure + 10n ** 18n],
      gas: 300_000n,
    });
    await send(ctx.publicClient, "approve(pool, liquidation)", hash);

    hash = await ctx.deployerWallet.writeContract({
      address: ctx.deployments.pool,
      abi: POOL_ABI,
      functionName: "liquidate",
      args: [ctx.borrower.address],
      gas: 400_000n,
    });
    await send(ctx.publicClient, "liquidate", hash);
  }

  console.log("\n-- completeUnwind --");
  hash = await ctx.deployerWallet.writeContract({
    address: ctx.deployments.guardian,
    abi: GUARDIAN_ABI,
    functionName: "completeUnwind",
    args: [ctx.borrower.address],
    gas: 400_000n,
  });
  await send(ctx.publicClient, "completeUnwind", hash);

  const finalPos = await ctx.publicClient.readContract({
    address: ctx.deployments.guardian,
    abi: GUARDIAN_ABI,
    functionName: "positions",
    args: [ctx.borrower.address],
  });
  console.log(`  final guardian position: state=${finalPos[0]} reason=${finalPos[1]}`);

  const finalPoolPosition = await ctx.publicClient.readContract({
    address: ctx.deployments.pool,
    abi: POOL_ABI,
    functionName: "positions",
    args: [ctx.borrower.address],
  });
  console.log(`  final pool position: collateral=${finalPoolPosition[0].toString()} principal=${finalPoolPosition[1].toString()} accruedInterest=${finalPoolPosition[2].toString()}`);

  const residual = finalPoolPosition[0];
  if (residual > 0n) {
    console.log(`\n-- Residual collateral (${residual.toString()}) exists, borrower withdraws it --`);
    hash = await ctx.borrowerWallet.writeContract({
      address: ctx.deployments.pool,
      abi: POOL_ABI,
      functionName: "withdrawCollateral",
      args: [residual],
      gas: 300_000n,
    });
    await send(ctx.publicClient, "withdrawCollateral (residual)", hash);
  } else {
    console.log("\n  No residual collateral, self-cure + liquidation consumed all of it (expected for this under-collateralized amount, see docs/DESIGN_A_SPIKE.md).");
  }
}

async function main() {
  const phase = process.argv[process.argv.indexOf("--phase") + 1];
  if (!phase) {
    console.error("usage: testnet-full-lifecycle.ts --phase <borrow|freeze|flag|unwind>");
    process.exitCode = 1;
    return;
  }

  const ctx = await loadContext();
  console.log(`pool: ${ctx.deployments.pool}`);
  console.log(`registry: ${ctx.deployments.registry}`);
  console.log(`guardian: ${ctx.deployments.guardian}`);
  console.log(`borrower: ${ctx.borrower.address}`);
  console.log(`attestor: ${ctx.attestor.address}`);

  if (phase === "borrow") await phaseBorrow(ctx);
  else if (phase === "freeze") await phaseFreeze(ctx);
  else if (phase === "flag") await phaseFlag(ctx);
  else if (phase === "unwind") await phaseUnwind(ctx);
  else {
    console.error(`unknown phase: ${phase}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("testnet-full-lifecycle failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
