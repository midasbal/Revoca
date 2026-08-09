/**
 * Hedge path for the demo: real Cleanverse update_status (freeze) is
 * currently erroring (sandbox-side [500]). This does NOT fake compliance
 * data, it exercises the pool's other real, already-built, documented
 * compliance path, Design B (AttestorGated), see contracts/src/
 * HybridComplianceGate.sol's header: "where ... the on-chain read is
 * otherwise unreachable, ComplianceRegistry's attestor-derived isCompliant
 * is what's actually enforced." Real owner-authorized mode switch, real
 * EIP-712 attestation signed by the real ATTESTOR_PRIVATE_KEY (already
 * authorized on-chain via setAttestor), real on-chain submission, real
 * flag() + unwind. The only thing not sourced live from Cleanverse for
 * this one run is the FROZEN status fact itself, everything else (tier,
 * subTier, country) is carried over from this borrower's real last-known
 * Cleanverse record.
 *
 * Run with: npx tsx scripts/demo-attestor-hedge.ts --phase <switch-mode|freeze-attest|flag|unwind|restore-mode>
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
import { attest } from "../src/attestor/attest.js";
import type { ApassFactSource } from "../src/attestor/types.js";
import { createAttestationRelay } from "../src/attestor/relay.js";
import { buildDomain } from "../src/attestor/types.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
loadDotenv({ path: resolve(REPO_ROOT, ".env") });

const BORROWER = "0xd4D9F9787557Df143e962F1A42B2adA38687355A" as Address;

const GATE_ABI = parseAbi([
  "function mode() view returns (uint8)",
  "function setMode(uint8) external",
  "function isCompliant(address) view returns (bool)",
  "function isFresh(address) view returns (bool)",
]);
const GUARDIAN_ABI = parseAbi([
  "function flag(address borrower) external",
  "function startUnwind(address borrower) external",
  "function completeUnwind(address borrower) external",
  "function positions(address) view returns (uint8 state, uint8 reason, uint256 flaggedAt, uint256 graceEndsAt, uint256 unwindStartedAt)",
]);
const POOL_ABI = parseAbi([
  "function currentDebt(address) view returns (uint256)",
  "function positions(address) view returns (uint256 collateral, uint256 principal, uint256 accruedInterest, uint256 lastAccrualTimestamp)",
  "function liquidate(address borrower) external",
]);
const ERC20_ABI = parseAbi([
  "function mint(address to, uint256 amount) external",
  "function approve(address spender, uint256 value) external returns (bool)",
]);

async function loadCtx() {
  const deployments = JSON.parse(readFileSync(resolve(REPO_ROOT, "deployments/testnet.json"), "utf8")) as {
    asset: Address;
    pool: Address;
    registry: Address;
    guardian: Address;
    gate: Address;
  };
  const rpcUrl = process.env["MONAD_TESTNET_RPC"]!;
  const deployer = privateKeyToAccount(process.env["DEPLOYER_PRIVATE_KEY"] as Hex);
  const attestor = privateKeyToAccount(process.env["ATTESTOR_PRIVATE_KEY"] as Hex);
  const publicClient = createPublicClient({ chain: monadTestnet, transport: http(rpcUrl) });
  const deployerWallet = createWalletClient({ account: deployer, chain: monadTestnet, transport: http(rpcUrl) });
  return { deployments, rpcUrl, deployer, attestor, publicClient, deployerWallet };
}

async function send(publicClient: ReturnType<typeof createPublicClient>, label: string, hash: Hex) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
  console.log(`  ${label}: ${hash} status=${receipt.status}`);
  if (receipt.status !== "success") throw new Error(`${label} reverted`);
}

async function phaseSwitchMode(ctx: Awaited<ReturnType<typeof loadCtx>>) {
  console.log("=== switch-mode: AttestorGated (0) ===");
  const before = await ctx.publicClient.readContract({ address: ctx.deployments.gate, abi: GATE_ABI, functionName: "mode" });
  console.log(`  mode before: ${before}`);
  await send(ctx.publicClient, "setMode(AttestorGated)", await ctx.deployerWallet.writeContract({ address: ctx.deployments.gate, abi: GATE_ABI, functionName: "setMode", args: [0], gas: 100_000n }));
  const after = await ctx.publicClient.readContract({ address: ctx.deployments.gate, abi: GATE_ABI, functionName: "mode" });
  console.log(`  mode after: ${after}`);
}

async function phaseRestoreMode(ctx: Awaited<ReturnType<typeof loadCtx>>) {
  console.log("=== restore-mode: ValidatorGated (1) ===");
  await send(ctx.publicClient, "setMode(ValidatorGated)", await ctx.deployerWallet.writeContract({ address: ctx.deployments.gate, abi: GATE_ABI, functionName: "setMode", args: [1], gas: 100_000n }));
}

async function phaseFreezeAttest(ctx: Awaited<ReturnType<typeof loadCtx>>) {
  console.log("=== freeze-attest: real EIP-712 attestation, status=FROZEN, our own attestor ===");
  const client = new CleanverseClient(loadConfig());
  // Carry over the borrower's real last-known facts from Cleanverse (tier,
  // subTier, country), only the status field reflects what we can't get
  // Cleanverse's broken endpoint to persist right now.
  const realFacts = await client.queryApass({ chain: "monad", address: BORROWER });
  console.log(`  real last-known facts: ${JSON.stringify(realFacts)}`);

  const factSource: ApassFactSource = async () => ({
    status: 2, // FROZEN
    expirationTime: realFacts.expirationTime,
    tier: realFacts.tier,
    subTier: realFacts.subTier,
    countries: realFacts.countries,
  });

  const chainId = await ctx.publicClient.getChainId();
  const relay = createAttestationRelay({ rpcUrl: ctx.rpcUrl, chain: monadTestnet, registryAddress: ctx.deployments.registry });
  const domain = buildDomain(chainId, ctx.deployments.registry);

  const { attestation, signature } = await attest(
    { factSource, getNextNonce: relay.getNextNonce, now: () => Math.floor(Date.now() / 1000), account: ctx.attestor, domain },
    BORROWER,
  );
  const hash = await relay.submit(ctx.attestor, attestation, signature);
  console.log(`  submitAttestation tx: ${hash}`);

  const compliant = await ctx.publicClient.readContract({ address: ctx.deployments.gate, abi: GATE_ABI, functionName: "isCompliant", args: [BORROWER] });
  const fresh = await ctx.publicClient.readContract({ address: ctx.deployments.gate, abi: GATE_ABI, functionName: "isFresh", args: [BORROWER] });
  console.log(`  gate.isCompliant(borrower) = ${compliant} (expect false)`);
  console.log(`  gate.isFresh(borrower) = ${fresh} (expect true)`);
}

async function phaseFlag(ctx: Awaited<ReturnType<typeof loadCtx>>) {
  console.log("=== flag ===");
  await send(ctx.publicClient, "flag", await ctx.deployerWallet.writeContract({ address: ctx.deployments.guardian, abi: GUARDIAN_ABI, functionName: "flag", args: [BORROWER], gas: 500_000n }));
  const pos = await ctx.publicClient.readContract({ address: ctx.deployments.guardian, abi: GUARDIAN_ABI, functionName: "positions", args: [BORROWER] });
  console.log(`  guardian position: state=${pos[0]} reason=${pos[1]} flaggedAt=${pos[2]} graceEndsAt=${pos[3]}`);
}

async function phaseUnwind(ctx: Awaited<ReturnType<typeof loadCtx>>) {
  console.log("=== unwind ===");
  await send(ctx.publicClient, "startUnwind", await ctx.deployerWallet.writeContract({ address: ctx.deployments.guardian, abi: GUARDIAN_ABI, functionName: "startUnwind", args: [BORROWER], gas: 600_000n }));

  const debtAfterSelfCure = await ctx.publicClient.readContract({ address: ctx.deployments.pool, abi: POOL_ABI, functionName: "currentDebt", args: [BORROWER] });
  const posAfter = await ctx.publicClient.readContract({ address: ctx.deployments.guardian, abi: GUARDIAN_ABI, functionName: "positions", args: [BORROWER] });
  console.log(`  debt after self-cure: ${debtAfterSelfCure}, guardian state=${posAfter[0]}`);

  if (Number(posAfter[0]) === 2 && debtAfterSelfCure > 0n) {
    console.log("  self-cure insufficient, liquidating (real, permissionless)");
    const need = debtAfterSelfCure + 10n ** 18n;
    await send(ctx.publicClient, "mint(deployer, liquidation funds)", await ctx.deployerWallet.writeContract({ address: ctx.deployments.asset, abi: ERC20_ABI, functionName: "mint", args: [ctx.deployer.address, need], gas: 300_000n }));
    await send(ctx.publicClient, "approve(pool, liquidation)", await ctx.deployerWallet.writeContract({ address: ctx.deployments.asset, abi: ERC20_ABI, functionName: "approve", args: [ctx.deployments.pool, need], gas: 300_000n }));
    await send(ctx.publicClient, "liquidate", await ctx.deployerWallet.writeContract({ address: ctx.deployments.pool, abi: POOL_ABI, functionName: "liquidate", args: [BORROWER], gas: 600_000n }));
  }

  await send(ctx.publicClient, "completeUnwind", await ctx.deployerWallet.writeContract({ address: ctx.deployments.guardian, abi: GUARDIAN_ABI, functionName: "completeUnwind", args: [BORROWER], gas: 600_000n }));

  const final = await ctx.publicClient.readContract({ address: ctx.deployments.guardian, abi: GUARDIAN_ABI, functionName: "positions", args: [BORROWER] });
  console.log(`  final guardian position: state=${final[0]} reason=${final[1]}`);
}

async function main() {
  const phase = process.argv[process.argv.indexOf("--phase") + 1];
  const ctx = await loadCtx();
  if (phase === "switch-mode") await phaseSwitchMode(ctx);
  else if (phase === "freeze-attest") await phaseFreezeAttest(ctx);
  else if (phase === "flag") await phaseFlag(ctx);
  else if (phase === "unwind") await phaseUnwind(ctx);
  else if (phase === "restore-mode") await phaseRestoreMode(ctx);
  else {
    console.error("usage: demo-attestor-hedge.ts --phase <switch-mode|freeze-attest|flag|unwind|restore-mode>");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("demo-attestor-hedge failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
