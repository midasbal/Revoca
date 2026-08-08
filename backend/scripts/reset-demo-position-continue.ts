/**
 * Continuation of reset-demo-position.ts, skipping the unfreeze step
 * (already confirmed active via query_apass). Fresh attestation, fund,
 * mint collateral, post collateral, borrow.
 *
 * Run with: npx tsx scripts/reset-demo-position-continue.ts
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
import { attest, cleanverseFactSource } from "../src/attestor/attest.js";
import { createAttestationRelay } from "../src/attestor/relay.js";
import { buildDomain } from "../src/attestor/types.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
loadDotenv({ path: resolve(REPO_ROOT, ".env") });

const ERC20_ABI = parseAbi([
  "function mint(address to, uint256 amount) external",
  "function approve(address spender, uint256 value) external returns (bool)",
]);
const POOL_ABI = parseAbi([
  "function postCollateral(uint256 amount) external",
  "function borrow(uint256 amount) external",
  "function currentRatioBps(address) external view returns (uint16)",
  "function currentDebt(address) external view returns (uint256)",
]);

const COLLATERAL_AMOUNT = 1000n * 10n ** 18n;
const BORROW_AMOUNT = 1200n * 10n ** 18n;

async function main() {
  const deployments = JSON.parse(readFileSync(resolve(REPO_ROOT, "deployments/testnet.json"), "utf8")) as {
    asset: Address;
    pool: Address;
    registry: Address;
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

  const client = new CleanverseClient(loadConfig());

  console.log(`Borrower: ${borrower.address}`);
  console.log(`Pool: ${deployments.pool}`);

  const facts = await client.queryApass({ chain: "monad", address: borrower.address });
  console.log(`query_apass: ${JSON.stringify(facts)}`);
  if (facts.status !== 1) {
    throw new Error(`Expected status 1 (active), got ${facts.status}`);
  }

  console.log("\n=== Fresh real attestation ===");
  const factSource = cleanverseFactSource(client, "monad");
  const chainId = await publicClient.getChainId();
  const relay = createAttestationRelay({ rpcUrl, chain: monadTestnet, registryAddress: deployments.registry });
  const domain = buildDomain(chainId, deployments.registry);

  const { attestation, signature } = await attest(
    { factSource, getNextNonce: relay.getNextNonce, now: () => Math.floor(Date.now() / 1000), account: attestor, domain },
    borrower.address,
  );
  const attestHash = await relay.submit(attestor, attestation, signature);
  console.log(`  submitAttestation tx: ${attestHash}`);
  await publicClient.waitForTransactionReceipt({ hash: attestHash, timeout: 180_000 });

  console.log("\n=== Fund + mint collateral asset ===");
  const fees = await publicClient.estimateFeesPerGas();
  const maxFeePerGas = fees.maxFeePerGas * 2n;
  const maxPriorityFeePerGas = fees.maxPriorityFeePerGas * 2n;

  const borrowerBalance = await publicClient.getBalance({ address: borrower.address });
  if (borrowerBalance < 3n * 10n ** 17n) {
    const hash = await deployerWallet.sendTransaction({
      to: borrower.address,
      value: 3n * 10n ** 17n,
      gas: 100_000n,
      maxFeePerGas,
      maxPriorityFeePerGas,
    });
    console.log(`  fund borrower MON tx: ${hash}`);
    await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
  }

  let hash = await deployerWallet.writeContract({
    address: deployments.asset,
    abi: ERC20_ABI,
    functionName: "mint",
    args: [borrower.address, COLLATERAL_AMOUNT],
    gas: 300_000n,
    maxFeePerGas,
    maxPriorityFeePerGas,
  });
  console.log(`  mint(borrower collateral) tx: ${hash}`);
  await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });

  console.log("\n=== Post collateral, borrow ===");
  hash = await borrowerWallet.writeContract({
    address: deployments.asset,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [deployments.pool, COLLATERAL_AMOUNT],
    gas: 300_000n,
    maxFeePerGas,
    maxPriorityFeePerGas,
  });
  console.log(`  approve tx: ${hash}`);
  await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });

  hash = await borrowerWallet.writeContract({
    address: deployments.pool,
    abi: POOL_ABI,
    functionName: "postCollateral",
    args: [COLLATERAL_AMOUNT],
    gas: 300_000n,
    maxFeePerGas,
    maxPriorityFeePerGas,
  });
  console.log(`  postCollateral tx: ${hash}`);
  await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });

  const ratio = await publicClient.readContract({
    address: deployments.pool,
    abi: POOL_ABI,
    functionName: "currentRatioBps",
    args: [borrower.address],
  });
  console.log(`  currentRatioBps: ${ratio}`);

  hash = await borrowerWallet.writeContract({
    address: deployments.pool,
    abi: POOL_ABI,
    functionName: "borrow",
    args: [BORROW_AMOUNT],
    gas: 400_000n,
    maxFeePerGas,
    maxPriorityFeePerGas,
  });
  console.log(`  borrow tx: ${hash}`);
  await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });

  const debt = await publicClient.readContract({
    address: deployments.pool,
    abi: POOL_ABI,
    functionName: "currentDebt",
    args: [borrower.address],
  });
  console.log(`\nDone. currentDebt: ${debt.toString()}`);
}

main().catch((err) => {
  console.error("reset-demo-position-continue failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
