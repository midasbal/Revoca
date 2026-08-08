/**
 * REAL Cleanverse UAT sandbox mutation: registers the real, deployed
 * LendingPool (see deployments/testnet.json, written by
 * testnet-deploy.ts) with the real on-chain CVI Compliance Validator on
 * Monad testnet, `validator/grant` then `validator/register`, the RESOLVED
 * signature scheme (docs/OPEN_QUESTIONS.md). PROVISIONAL, per this
 * session's scoping, see testnet-deploy.ts's header.
 *
 * Rule sent matches CompliancePolicy's actual default (minTier=0,
 * minSubTier=0, no restriction beyond A-Pass validity itself), so the
 * on-chain rule genuinely mirrors what this pool's own policy enforces,
 * not an arbitrary placeholder.
 *
 * After registering, confirms complianceVerify(pool, user) against real
 * addresses: our own deployer (no A-Pass, expect false) and the two known
 * real active A-Passes already confirmed this session
 * (docs/DESIGN_A_SPIKE.md section 5, expect true), proving the wiring
 * generalizes to this new pool address, not just the throwaway probe.
 *
 * Run with: npx tsx scripts/testnet-register-pool.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createPublicClient, createWalletClient, http, parseAbi, type Address, type Hex } from "viem";
import { monadTestnet } from "viem/chains";
import { config as loadDotenv } from "dotenv";

import { loadConfig } from "../src/cleanverse/config.js";
import { CleanverseClient } from "../src/cleanverse/client.js";
import { CleanverseApiError, CleanverseTransportError, CleanverseResponseShapeError } from "../src/cleanverse/errors.js";
import { ownerSignature, accountFromPrivateKey } from "../src/cleanverse/signature.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
loadDotenv({ path: resolve(REPO_ROOT, ".env") });

const CHAIN_SLUG = "monad";
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
  const deploymentsPath = resolve(REPO_ROOT, "deployments/testnet.json");
  const deployments = JSON.parse(readFileSync(deploymentsPath, "utf8")) as { pool: Address; deployer: Address };
  const poolAddress = deployments.pool;
  console.log(`Registering pool: ${poolAddress}`);

  const deployerPk = process.env["DEPLOYER_PRIVATE_KEY"] as Hex;
  const rpcUrl = process.env["MONAD_TESTNET_RPC"]!;
  const deployerAccount = accountFromPrivateKey(deployerPk);
  const publicClient = createPublicClient({ chain: monadTestnet, transport: http(rpcUrl) });

  const cleanverseConfig = loadConfig();
  const client = new CleanverseClient(cleanverseConfig);

  console.log("\n=== validator/grant ===");
  const grantSignature = await ownerSignature(CHAIN_SLUG, poolAddress, deployerAccount);
  let grantSucceeded = false;
  try {
    const result = await client.validatorGrant({ chain: CHAIN_SLUG, address: poolAddress, owner_signature: grantSignature });
    grantSucceeded = true;
    console.log(`  SUCCESS ${JSON.stringify(result)}`);
  } catch (err) {
    reportCleanverseError("validator/grant", err);
  }

  console.log("\n=== validator/register ===");
  const registerSignature = await ownerSignature(CHAIN_SLUG, poolAddress, deployerAccount);
  let registerSucceeded = false;
  try {
    const result = await client.validatorRegister({
      chain: CHAIN_SLUG,
      contract_address: poolAddress,
      rule: { allowed_group: "", allowed_sub_group: "", min_tier: 0, min_sub_tier: 0 },
      owner_signature: registerSignature,
    });
    registerSucceeded = true;
    console.log(`  SUCCESS ${JSON.stringify(result)}`);
  } catch (err) {
    reportCleanverseError("validator/register", err);
  }

  console.log(`\ngrantSucceeded: ${grantSucceeded}, registerSucceeded: ${registerSucceeded}`);

  console.log("\n=== isRegistered(pool) on-chain ===");
  const registered = await publicClient.readContract({
    address: VALIDATOR_ADDRESS,
    abi: VALIDATOR_READ_ABI,
    functionName: "isRegistered",
    args: [poolAddress],
  });
  console.log(`  isRegistered(${poolAddress}) = ${registered}`);

  const checks: Array<{ label: string; address: Address; expect: boolean }> = [
    { label: "deployer (no A-Pass)", address: deployments.deployer, expect: false },
    { label: "known real active A-Pass #1", address: "0xA5d56A6a4451d339ed68cc3302bc0bDbb214F0Fa", expect: true },
    { label: "known real active A-Pass #2", address: "0x676CBD5978FdeBa8C9e55Bf122B366F9a1734019", expect: true },
  ];

  console.log("\n=== complianceVerify(pool, user) for known real addresses ===");
  for (const check of checks) {
    try {
      const result = await publicClient.readContract({
        address: VALIDATOR_ADDRESS,
        abi: VALIDATOR_READ_ABI,
        functionName: "complianceVerify",
        args: [poolAddress, check.address],
      });
      console.log(`  ${check.label} (${check.address}): complianceVerify = ${result} (expected ${check.expect}, match: ${result === check.expect})`);
    } catch (err) {
      console.log(`  ${check.label} (${check.address}): REVERTED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

main().catch((err) => {
  console.error("testnet-register-pool failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
