/**
 * REAL end-to-end test of the borrower onboarding backend
 * (src/onboarding/provision.ts): generates a fresh Monad testnet wallet,
 * runs the real provisioning sequence against it (generate_apass,
 * query_apass verify, real on-chain attestation, real gas + rtUSD
 * funding), then confirms the borrower can actually post collateral and
 * borrow against the resulting on-chain standing. No mock data.
 *
 * Persists the fresh private key to .env (never printed), same pattern
 * as testnet-generate-apasses.ts, so the funded, provisioned wallet stays
 * reusable for follow-up manual checks.
 *
 * Run with: npx tsx scripts/testnet-onboarding-e2e.ts
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { monadTestnet } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { config as loadDotenv } from "dotenv";

import { provisionBorrower } from "../src/onboarding/provision.js";
import { DEPLOYMENT } from "../src/onboarding/deployment.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ENV_PATH = resolve(REPO_ROOT, ".env");
loadDotenv({ path: ENV_PATH });

const ENV_VAR = "TESTNET_ONBOARDING_TEST_PRIVATE_KEY";

function persistSecretToEnv(key: string, value: string): void {
  const existing = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  if (new RegExp(`^${key}=.+$`, "m").test(existing)) return;
  appendFileSync(ENV_PATH, `${existing.endsWith("\n") || existing === "" ? "" : "\n"}${key}=${value}\n`);
}

async function main() {
  const startedAt = Date.now();

  let pk = process.env[ENV_VAR] as `0x${string}` | undefined;
  if (!pk) {
    pk = generatePrivateKey();
    persistSecretToEnv(ENV_VAR, pk);
  }
  const account = privateKeyToAccount(pk);
  console.log(`Test borrower: ${account.address}`);

  console.log("\n=== provisionBorrower(address, subTier: '50') ===");
  const result = await provisionBorrower(account.address, "50");
  console.log(JSON.stringify(result, null, 2));
  console.log(`\nprovisionBorrower took ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

  const rpcUrl = process.env["MONAD_TESTNET_RPC"] || "https://testnet-rpc.monad.xyz";
  const publicClient = createPublicClient({ chain: monadTestnet, transport: http(rpcUrl) });

  console.log("\n=== Confirming real on-chain effects ===");
  const GATE_ABI = parseAbi(["function isCompliant(address) external view returns (bool)", "function isFresh(address) external view returns (bool)"]);
  const REGISTRY_ABI = parseAbi(["function tierOf(address) external view returns (uint16,uint16)"]);
  const POOL_ABI = parseAbi(["function currentRatioBps(address) external view returns (uint16)"]);
  const ASSET_ABI = parseAbi([
    "function balanceOf(address) external view returns (uint256)",
    "function approve(address,uint256) external returns (bool)",
  ]);

  const [compliant, fresh, tier, ratioBps, assetBalance, gasBalance] = await Promise.all([
    publicClient.readContract({ address: DEPLOYMENT.gate, abi: GATE_ABI, functionName: "isCompliant", args: [account.address] }),
    publicClient.readContract({ address: DEPLOYMENT.gate, abi: GATE_ABI, functionName: "isFresh", args: [account.address] }),
    publicClient.readContract({ address: DEPLOYMENT.registry, abi: REGISTRY_ABI, functionName: "tierOf", args: [account.address] }),
    publicClient.readContract({ address: DEPLOYMENT.pool, abi: POOL_ABI, functionName: "currentRatioBps", args: [account.address] }),
    publicClient.readContract({ address: DEPLOYMENT.asset, abi: ASSET_ABI, functionName: "balanceOf", args: [account.address] }),
    publicClient.getBalance({ address: account.address }),
  ]);

  console.log(`  gate.isCompliant: ${compliant}`);
  console.log(`  gate.isFresh: ${fresh}`);
  console.log(`  registry.tierOf: tier=${tier[0]} subTier=${tier[1]}`);
  console.log(`  pool.currentRatioBps: ${ratioBps} (${(ratioBps / 100).toFixed(0)}%)`);
  console.log(`  rtUSD balance: ${(assetBalance / 10n ** 18n).toString()}`);
  console.log(`  MON gas balance: ${gasBalance.toString()}`);

  if (!compliant) throw new Error("FAIL: gate.isCompliant is false after provisioning, borrow() would revert.");
  if (!fresh) throw new Error("FAIL: gate.isFresh is false after provisioning.");
  if (tier[0] !== 50 || tier[1] !== 50) throw new Error(`FAIL: expected tier=50 subTier=50, got tier=${tier[0]} subTier=${tier[1]}`);

  console.log("\n=== Real borrow: post collateral, borrow against the real tier-derived ratio ===");
  const wallet = createWalletClient({ account, chain: monadTestnet, transport: http(rpcUrl) });
  const fees = await publicClient.estimateFeesPerGas();
  const maxFeePerGas = fees.maxFeePerGas * 2n;
  const maxPriorityFeePerGas = fees.maxPriorityFeePerGas * 2n;
  const COLLATERAL = 500n * 10n ** 18n;

  let hash = await wallet.writeContract({
    address: DEPLOYMENT.asset,
    abi: ASSET_ABI,
    functionName: "approve",
    args: [DEPLOYMENT.pool, COLLATERAL],
    ...(await gasFor(publicClient, DEPLOYMENT.asset, ASSET_ABI, "approve", [DEPLOYMENT.pool, COLLATERAL], account.address)),
    maxFeePerGas,
    maxPriorityFeePerGas,
  });
  await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
  console.log(`  approve tx: ${hash}`);

  const POOL_WRITE_ABI = parseAbi([
    "function postCollateral(uint256) external",
    "function borrow(uint256) external",
    "function repay(uint256) external",
    "function withdrawCollateral(uint256) external",
    "function currentDebt(address) external view returns (uint256)",
  ]);
  hash = await wallet.writeContract({
    address: DEPLOYMENT.pool,
    abi: POOL_WRITE_ABI,
    functionName: "postCollateral",
    args: [COLLATERAL],
    ...(await gasFor(publicClient, DEPLOYMENT.pool, POOL_WRITE_ABI, "postCollateral", [COLLATERAL], account.address)),
    maxFeePerGas,
    maxPriorityFeePerGas,
  });
  await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
  console.log(`  postCollateral tx: ${hash}`);

  const borrowAmount = (COLLATERAL * 10_000n) / BigInt(ratioBps) - 10n * 10n ** 18n; // headroom under the max
  hash = await wallet.writeContract({
    address: DEPLOYMENT.pool,
    abi: POOL_WRITE_ABI,
    functionName: "borrow",
    args: [borrowAmount],
    ...(await gasFor(publicClient, DEPLOYMENT.pool, POOL_WRITE_ABI, "borrow", [borrowAmount], account.address)),
    maxFeePerGas,
    maxPriorityFeePerGas,
  });
  const borrowReceipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
  console.log(`  borrow tx: ${hash} (${borrowReceipt.status})`);

  const debt = await publicClient.readContract({ address: DEPLOYMENT.pool, abi: POOL_WRITE_ABI, functionName: "currentDebt", args: [account.address] });
  console.log(`  currentDebt after borrow: ${(debt / 10n ** 18n).toString()} rtUSD`);
  if (borrowReceipt.status !== "success" || debt === 0n) throw new Error("FAIL: borrow did not actually create debt.");

  console.log("\n=== Real repay in full, then withdraw all collateral ===");
  const maxUint256 = 2n ** 256n - 1n;
  hash = await wallet.writeContract({
    address: DEPLOYMENT.asset,
    abi: ASSET_ABI,
    functionName: "approve",
    args: [DEPLOYMENT.pool, maxUint256],
    ...(await gasFor(publicClient, DEPLOYMENT.asset, ASSET_ABI, "approve", [DEPLOYMENT.pool, maxUint256], account.address)),
    maxFeePerGas,
    maxPriorityFeePerGas,
  });
  await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });

  hash = await wallet.writeContract({
    address: DEPLOYMENT.pool,
    abi: POOL_WRITE_ABI,
    functionName: "repay",
    args: [maxUint256],
    ...(await gasFor(publicClient, DEPLOYMENT.pool, POOL_WRITE_ABI, "repay", [maxUint256], account.address)),
    maxFeePerGas,
    maxPriorityFeePerGas,
  });
  const repayReceipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
  console.log(`  repay tx: ${hash} (${repayReceipt.status})`);

  const debtAfterRepay = await publicClient.readContract({ address: DEPLOYMENT.pool, abi: POOL_WRITE_ABI, functionName: "currentDebt", args: [account.address] });
  console.log(`  debt after full repay: ${debtAfterRepay.toString()}`);
  if (debtAfterRepay !== 0n) throw new Error("FAIL: debt is not zero after a full repay.");

  hash = await wallet.writeContract({
    address: DEPLOYMENT.pool,
    abi: POOL_WRITE_ABI,
    functionName: "withdrawCollateral",
    args: [COLLATERAL],
    ...(await gasFor(publicClient, DEPLOYMENT.pool, POOL_WRITE_ABI, "withdrawCollateral", [COLLATERAL], account.address)),
    maxFeePerGas,
    maxPriorityFeePerGas,
  });
  const withdrawReceipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
  console.log(`  withdrawCollateral tx: ${hash} (${withdrawReceipt.status})`);
  if (withdrawReceipt.status !== "success") throw new Error("FAIL: withdrawCollateral reverted after full repayment.");

  console.log(`\nTotal wall-clock time: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  console.log("\n=== PASS: real onboarding -> real standing -> real borrow -> real repay -> real withdraw, end to end ===");
}

/** Estimates gas for a write call and returns it with a 50% buffer, real Monad testnet gasUsed for borrow() ran well above a flat 300k in this session's testing, never hardcode a guessed limit for a pool write. */
async function gasFor(
  publicClient: ReturnType<typeof createPublicClient>,
  address: `0x${string}`,
  abi: ReturnType<typeof parseAbi>,
  functionName: string,
  args: readonly unknown[],
  account: `0x${string}`,
): Promise<{ gas: bigint }> {
  const estimate = await publicClient.estimateContractGas({ address, abi, functionName, args, account } as never);
  return { gas: (estimate * 3n) / 2n };
}

main().catch((err) => {
  console.error("\ntestnet-onboarding-e2e FAILED:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
