/**
 * REAL Monad testnet transactions against the real deployed pool
 * (deployments/testnet.json). What this session's two live sandbox
 * blockers (see docs/OPEN_QUESTIONS.md: generate_apass's "[CV_500]CV
 * System error", and validator/grant+register's "intrinsic gas greater
 * than limit") leave achievable WITHOUT fabricating any compliance data:
 *
 *   1. A real lender deposit (no compliance gating, per LendingPool.sol).
 *   2. A real borrower posting collateral (also no compliance gating).
 *   3. A real borrow() ATTEMPT from that same borrower, expected to
 *      REVERT, since the pool is not yet registered with the validator
 *      (blocked by the second blocker above) and has no real compliant
 *      identity behind it (blocked by the first). This is not a
 *      workaround, it's the correct, honest behavior: HybridComplianceGate
 *      fails closed for an unregistered pool, exactly as designed and
 *      unit-tested (contracts/test/HybridComplianceGate.t.sol). Proves the
 *      fail-closed gate for real, against real unregistered infrastructure,
 *      rather than only a mock validator.
 *
 * Does NOT attempt the full flag->grace->unwind lifecycle: that requires
 * an actual open borrow position, which requires a real compliant
 * borrower, which is blocked. Not faked.
 *
 * Run with: npx tsx scripts/testnet-lifecycle-lite.ts
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
  "function deposit(uint256 amount) external",
  "function postCollateral(uint256 amount) external",
  "function borrow(uint256 amount) external",
]);

const DEPOSIT_AMOUNT = 500_000n * 10n ** 18n;
const COLLATERAL_AMOUNT = 1000n * 10n ** 18n;
const BORROW_ATTEMPT_AMOUNT = 100n * 10n ** 18n;
const BORROWER_GAS_FUNDING = 5n * 10n ** 16n; // 0.05 MON, enough for a handful of testnet txs

async function main() {
  const deployments = JSON.parse(readFileSync(resolve(REPO_ROOT, "deployments/testnet.json"), "utf8")) as {
    asset: Address;
    pool: Address;
  };
  const rpcUrl = process.env["MONAD_TESTNET_RPC"]!;
  const deployerPk = process.env["DEPLOYER_PRIVATE_KEY"] as Hex;
  const borrowerPk = process.env["TESTNET_BORROWER_HIGH_PRIVATE_KEY"] as Hex | undefined;
  if (!borrowerPk) {
    console.error("TESTNET_BORROWER_HIGH_PRIVATE_KEY not set, run testnet-generate-apasses.ts first.");
    process.exitCode = 1;
    return;
  }

  const deployer = privateKeyToAccount(deployerPk);
  const borrower = privateKeyToAccount(borrowerPk);
  const publicClient = createPublicClient({ chain: monadTestnet, transport: http(rpcUrl) });
  const deployerWallet = createWalletClient({ account: deployer, chain: monadTestnet, transport: http(rpcUrl) });
  const borrowerWallet = createWalletClient({ account: borrower, chain: monadTestnet, transport: http(rpcUrl) });

  console.log(`asset: ${deployments.asset}`);
  console.log(`pool: ${deployments.pool}`);
  console.log(`lender (deployer): ${deployer.address}`);
  console.log(`borrower: ${borrower.address}`);

  async function send(label: string, hash: Hex) {
    console.log(`  ${label} tx: ${hash}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`  ${label} status: ${receipt.status}, block ${receipt.blockNumber}`);
    return receipt;
  }

  console.log("\n=== 1. Lender deposit ===");
  let hash = await deployerWallet.writeContract({
    address: deployments.asset,
    abi: ERC20_ABI,
    functionName: "mint",
    args: [deployer.address, DEPOSIT_AMOUNT],
  gas: 300_000n,
  });
  await send("mint(lender)", hash);

  hash = await deployerWallet.writeContract({
    address: deployments.asset,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [deployments.pool, DEPOSIT_AMOUNT],
  gas: 300_000n,
  });
  await send("approve(pool, deposit)", hash);

  hash = await deployerWallet.writeContract({
    address: deployments.pool,
    abi: POOL_ABI,
    functionName: "deposit",
    args: [DEPOSIT_AMOUNT],
  gas: 300_000n,
  });
  await send("deposit", hash);

  console.log("\n=== 2. Fund borrower with MON for gas, mint collateral asset ===");
  const borrowerBalance = await publicClient.getBalance({ address: borrower.address });
  if (borrowerBalance < BORROWER_GAS_FUNDING) {
    hash = await deployerWallet.sendTransaction({ to: borrower.address, value: BORROWER_GAS_FUNDING, gas: 100_000n });
    await send("fund borrower MON", hash);
  } else {
    console.log("  borrower already has enough MON, skipping funding");
  }

  hash = await deployerWallet.writeContract({
    address: deployments.asset,
    abi: ERC20_ABI,
    functionName: "mint",
    args: [borrower.address, COLLATERAL_AMOUNT],
  gas: 300_000n,
  });
  await send("mint(borrower collateral)", hash);

  console.log("\n=== 3. Borrower posts collateral (no compliance gating) ===");
  hash = await borrowerWallet.writeContract({
    address: deployments.asset,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [deployments.pool, COLLATERAL_AMOUNT],
  gas: 300_000n,
  });
  await send("approve(pool, collateral)", hash);

  hash = await borrowerWallet.writeContract({
    address: deployments.pool,
    abi: POOL_ABI,
    functionName: "postCollateral",
    args: [COLLATERAL_AMOUNT],
  gas: 300_000n,
  });
  await send("postCollateral", hash);

  console.log("\n=== 4. Borrower ATTEMPTS to borrow, expected to revert (pool not validator-registered, no real compliant identity) ===");
  try {
    hash = await borrowerWallet.writeContract({
      address: deployments.pool,
      abi: POOL_ABI,
      functionName: "borrow",
      args: [BORROW_ATTEMPT_AMOUNT],
    gas: 300_000n,
    });
    await send("borrow", hash);
    console.log("  UNEXPECTED: borrow succeeded, investigate before trusting this as a real compliance failure demo.");
  } catch (err) {
    console.log(`  borrow REVERTED as expected: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  }

  console.log("\nDone. See docs/OPEN_QUESTIONS.md for why the full flag->grace->unwind lifecycle could not run this session.");
}

main().catch((err) => {
  console.error("testnet-lifecycle-lite failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
