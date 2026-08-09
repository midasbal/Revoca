/**
 * The existing reset-demo-position(-continue).ts scripts assume a zero
 * starting position; if the demo borrower's position ever has leftover
 * debt (real, documented interest behavior, not a bug, see
 * LendingPool.sol's currentDebt header, current-rate-over-full-elapsed-
 * window compounding can leave a large real balance on an untouched
 * position), their fresh postCollateral+borrow reverts on the health
 * check, correctly. This script actually clears the position to zero
 * first: mint enough rtUSD to fully repay, repay, withdraw all collateral,
 * then rebuild a clean 1000 collateral / 1200 borrow position. Real
 * testnet only, no mock data. Use this whenever reset-demo-position(-
 * continue).ts reverts on the borrow step.
 *
 * Run with: npx tsx scripts/reset-demo-position-full-clear.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createPublicClient, createWalletClient, http, parseAbi, type Address, type Hex } from "viem";
import { monadTestnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { config as loadDotenv } from "dotenv";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
loadDotenv({ path: resolve(REPO_ROOT, ".env") });

const ERC20_ABI = parseAbi([
  "function mint(address to, uint256 amount) external",
  "function approve(address spender, uint256 value) external returns (bool)",
]);
const POOL_ABI = parseAbi([
  "function postCollateral(uint256 amount) external",
  "function borrow(uint256 amount) external",
  "function repay(uint256 amount) external",
  "function withdrawCollateral(uint256 amount) external",
  "function currentDebt(address) view returns (uint256)",
  "function currentRatioBps(address) view returns (uint16)",
  "function positions(address) view returns (uint256 collateral, uint256 principal, uint256 accruedInterest, uint256 lastAccrualTimestamp)",
]);

const COLLATERAL_AMOUNT = 1000n * 10n ** 18n;
const BORROW_AMOUNT = 1200n * 10n ** 18n;

async function send(publicClient: ReturnType<typeof createPublicClient>, label: string, hash: Hex) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
  console.log(`  ${label}: ${hash} status=${receipt.status}`);
  if (receipt.status !== "success") throw new Error(`${label} reverted`);
}

async function main() {
  const deployments = JSON.parse(readFileSync(resolve(REPO_ROOT, "deployments/testnet.json"), "utf8")) as {
    asset: Address;
    pool: Address;
  };
  const rpcUrl = process.env["MONAD_TESTNET_RPC"]!;
  const deployerPk = process.env["DEPLOYER_PRIVATE_KEY"] as Hex;
  const borrowerPk = process.env["TESTNET_BORROWER_HIGH_PRIVATE_KEY"] as Hex;

  const deployer = privateKeyToAccount(deployerPk);
  const borrower = privateKeyToAccount(borrowerPk);

  const publicClient = createPublicClient({ chain: monadTestnet, transport: http(rpcUrl) });
  const deployerWallet = createWalletClient({ account: deployer, chain: monadTestnet, transport: http(rpcUrl) });
  const borrowerWallet = createWalletClient({ account: borrower, chain: monadTestnet, transport: http(rpcUrl) });

  console.log(`Borrower: ${borrower.address}`);

  const debtNow = await publicClient.readContract({ address: deployments.pool, abi: POOL_ABI, functionName: "currentDebt", args: [borrower.address] });
  console.log(`Current debt (growing every second): ${debtNow.toString()}`);

  const repayFund = debtNow + 500n * 10n ** 18n; // generous headroom, repay() caps to actual owed anyway
  console.log(`\n=== 1. Mint ${repayFund.toString()} rtUSD to borrower for full repay ===`);
  await send(publicClient, "mint(borrower, repayFund)", await deployerWallet.writeContract({ address: deployments.asset, abi: ERC20_ABI, functionName: "mint", args: [borrower.address, repayFund], gas: 300_000n }));

  console.log("\n=== 2. approve + repay (full debt) ===");
  await send(publicClient, "approve(pool, repayFund)", await borrowerWallet.writeContract({ address: deployments.asset, abi: ERC20_ABI, functionName: "approve", args: [deployments.pool, repayFund], gas: 300_000n }));
  await send(publicClient, "repay(repayFund)", await borrowerWallet.writeContract({ address: deployments.pool, abi: POOL_ABI, functionName: "repay", args: [repayFund], gas: 400_000n }));

  const posAfterRepay = await publicClient.readContract({ address: deployments.pool, abi: POOL_ABI, functionName: "positions", args: [borrower.address] });
  console.log(`  collateral=${posAfterRepay[0]} principal=${posAfterRepay[1]} accruedInterest=${posAfterRepay[2]}`);

  console.log("\n=== 3. withdrawCollateral (full remaining) ===");
  await send(publicClient, "withdrawCollateral(all)", await borrowerWallet.writeContract({ address: deployments.pool, abi: POOL_ABI, functionName: "withdrawCollateral", args: [posAfterRepay[0]], gas: 400_000n }));

  const posClean = await publicClient.readContract({ address: deployments.pool, abi: POOL_ABI, functionName: "positions", args: [borrower.address] });
  console.log(`  after withdraw: collateral=${posClean[0]} principal=${posClean[1]} accruedInterest=${posClean[2]}`);
  if (posClean[0] !== 0n || posClean[1] !== 0n) throw new Error("Position not actually clean, aborting before rebuilding");

  console.log("\n=== 4. Mint fresh collateral, post + borrow clean ===");
  await send(publicClient, "mint(borrower, COLLATERAL_AMOUNT)", await deployerWallet.writeContract({ address: deployments.asset, abi: ERC20_ABI, functionName: "mint", args: [borrower.address, COLLATERAL_AMOUNT], gas: 300_000n }));
  await send(publicClient, "approve(pool, COLLATERAL_AMOUNT)", await borrowerWallet.writeContract({ address: deployments.asset, abi: ERC20_ABI, functionName: "approve", args: [deployments.pool, COLLATERAL_AMOUNT], gas: 300_000n }));
  await send(publicClient, "postCollateral(COLLATERAL_AMOUNT)", await borrowerWallet.writeContract({ address: deployments.pool, abi: POOL_ABI, functionName: "postCollateral", args: [COLLATERAL_AMOUNT], gas: 300_000n }));
  await send(publicClient, "borrow(BORROW_AMOUNT)", await borrowerWallet.writeContract({ address: deployments.pool, abi: POOL_ABI, functionName: "borrow", args: [BORROW_AMOUNT], gas: 400_000n }));

  const final = await publicClient.readContract({ address: deployments.pool, abi: POOL_ABI, functionName: "positions", args: [borrower.address] });
  const finalDebt = await publicClient.readContract({ address: deployments.pool, abi: POOL_ABI, functionName: "currentDebt", args: [borrower.address] });
  const finalRatio = await publicClient.readContract({ address: deployments.pool, abi: POOL_ABI, functionName: "currentRatioBps", args: [borrower.address] });
  console.log(`\nFinal clean position: collateral=${final[0]} principal=${final[1]} accruedInterest=${final[2]} currentDebt=${finalDebt} requiredRatioBps=${finalRatio}`);
}

main().catch((err) => {
  console.error("reset-demo-position-full-clear failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
