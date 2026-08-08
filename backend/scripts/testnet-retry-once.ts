/**
 * ONE-SHOT retry, per explicit instruction: Cleanverse Telegram signal
 * suggests the two server-side write failures from earlier this session
 * (generate_apass CV_500, validator/grant+register 12026) may now be
 * fixed. This script attempts EACH exactly once, no loop, no retry on
 * failure, reports the real response verbatim either way.
 *
 * 1. generate_apass for TESTNET_BORROWER_HIGH_PRIVATE_KEY's wallet (the
 *    same wallet from the earlier failed attempt), subTier as a STRING.
 *    If it succeeds, verifies via query_apass (singular) that the A-Pass
 *    actually exists and that tier/subTier took the intended values, per
 *    the confirmed silent-ignore gotcha, never trusting the success
 *    response alone.
 * 2. validator/grant + validator/register for the already-deployed
 *    testnet LendingPool (deployments/testnet.json), the same resolved
 *    signing scheme used successfully earlier in the window. If register
 *    succeeds, confirms isRegistered(pool) on-chain, then reports
 *    complianceVerify(pool, thatWallet).
 *
 * Run with: npx tsx scripts/testnet-retry-once.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createPublicClient, http, parseAbi, type Address, type Hex } from "viem";
import { monadTestnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { config as loadDotenv } from "dotenv";

import { loadConfig } from "../src/cleanverse/config.js";
import { CleanverseClient } from "../src/cleanverse/client.js";
import { CleanverseApiError, CleanverseTransportError, CleanverseResponseShapeError } from "../src/cleanverse/errors.js";
import { ownerSignature, accountFromPrivateKey } from "../src/cleanverse/signature.js";
import type { GenerateApassParams } from "../src/cleanverse/types.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
loadDotenv({ path: resolve(REPO_ROOT, ".env") });

const VALIDATOR_ADDRESS = "0xaC7e5179C2C7f03f209136886c172eb34F161792" as const satisfies Address;
const VALIDATOR_READ_ABI = parseAbi([
  "function complianceVerify(address poolAddress, address userAddress) external view returns (bool)",
  "function isRegistered(address poolAddress) external view returns (bool)",
]);

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

async function main() {
  const borrowerPk = process.env["TESTNET_BORROWER_HIGH_PRIVATE_KEY"] as Hex | undefined;
  if (!borrowerPk) {
    console.error("TESTNET_BORROWER_HIGH_PRIVATE_KEY not set.");
    process.exitCode = 1;
    return;
  }
  const borrower = privateKeyToAccount(borrowerPk);
  const client = new CleanverseClient(loadConfig());

  console.log(`Test wallet: ${borrower.address}`);

  // -----------------------------------------------------------------
  // 1. generate_apass, ONE attempt, subTier as a STRING.
  // -----------------------------------------------------------------
  console.log("\n=== 1. generate_apass (one attempt) ===");
  const expirationTime = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;
  const params = {
    customerId: "revocaretryonce1",
    subTier: "80",
    expirationTime,
    wallet: { address: borrower.address, chain: "monad" },
  } as GenerateApassParams;

  let generateSucceeded = false;
  try {
    const result = await client.generateApass(params);
    generateSucceeded = true;
    console.log(`  SUCCESS: ${JSON.stringify(result)}`);
  } catch (err) {
    reportCleanverseError("generate_apass", err);
  }

  if (generateSucceeded) {
    console.log("\n  Verifying via query_apass (singular)...");
    try {
      const verified = await client.queryApass({ chain: "monad", address: borrower.address });
      console.log(`  query_apass: ${JSON.stringify(verified)}`);
      console.log(`  subTier matches intent ("80"): ${String(verified.subTier) === "80"}`);
    } catch (err) {
      reportCleanverseError("query_apass (verify)", err);
    }
  }

  // -----------------------------------------------------------------
  // 2. validator/grant + validator/register, ONE attempt each, for the
  //    already-deployed real LendingPool.
  // -----------------------------------------------------------------
  const deployments = JSON.parse(readFileSync(resolve(REPO_ROOT, "deployments/testnet.json"), "utf8")) as {
    pool: Address;
  };
  const poolAddress = deployments.pool;
  const deployerPk = process.env["DEPLOYER_PRIVATE_KEY"] as Hex;
  const deployerAccount = accountFromPrivateKey(deployerPk);
  const rpcUrl = process.env["MONAD_TESTNET_RPC"]!;
  const publicClient = createPublicClient({ chain: monadTestnet, transport: http(rpcUrl) });

  console.log(`\n=== 2. validator/grant (one attempt), pool ${poolAddress} ===`);
  const grantSignature = await ownerSignature("monad", poolAddress, deployerAccount);
  let grantSucceeded = false;
  try {
    const result = await client.validatorGrant({ chain: "monad", address: poolAddress, owner_signature: grantSignature });
    grantSucceeded = true;
    console.log(`  SUCCESS: ${JSON.stringify(result)}`);
  } catch (err) {
    reportCleanverseError("validator/grant", err);
  }

  console.log("\n=== 2. validator/register (one attempt) ===");
  const registerSignature = await ownerSignature("monad", poolAddress, deployerAccount);
  let registerSucceeded = false;
  try {
    const result = await client.validatorRegister({
      chain: "monad",
      contract_address: poolAddress,
      rule: { allowed_group: "", allowed_sub_group: "", min_tier: 0, min_sub_tier: 0 },
      owner_signature: registerSignature,
    });
    registerSucceeded = true;
    console.log(`  SUCCESS: ${JSON.stringify(result)}`);
  } catch (err) {
    reportCleanverseError("validator/register", err);
  }

  console.log(`\ngrantSucceeded: ${grantSucceeded}, registerSucceeded: ${registerSucceeded}`);

  if (registerSucceeded) {
    const registered = await publicClient.readContract({
      address: VALIDATOR_ADDRESS,
      abi: VALIDATOR_READ_ABI,
      functionName: "isRegistered",
      args: [poolAddress],
    });
    console.log(`\nisRegistered(${poolAddress}) = ${registered}`);

    try {
      const result = await publicClient.readContract({
        address: VALIDATOR_ADDRESS,
        abi: VALIDATOR_READ_ABI,
        functionName: "complianceVerify",
        args: [poolAddress, borrower.address],
      });
      console.log(`complianceVerify(${poolAddress}, ${borrower.address}) = ${result}`);
    } catch (err) {
      console.log(`complianceVerify REVERTED: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    }
  }
}

main().catch((err) => {
  console.error("testnet-retry-once failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
