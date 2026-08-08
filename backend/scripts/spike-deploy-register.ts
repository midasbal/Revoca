/**
 * SPIKE / PROBE SCRIPT. Real Monad testnet deploy, real Cleanverse UAT
 * sandbox mutation calls (validator/grant, validator/register), real
 * on-chain reads. Not part of the real keeper/attestor/audit paths, and
 * NOT wired into LendingPool/RevocationGuardian/ComplianceRegistry. Proves
 * (or disproves) the registration handshake documented as RESOLVED in
 * docs/OPEN_QUESTIONS.md (gitignored, local) before any of this becomes
 * real integration code. See docs/ROADMAP.md Phase 3's 3a.
 *
 * Steps:
 *   1. Deploy contracts/src/spike/MinimalRegistrationProbe.sol to Monad
 *      testnet, owner = DEPLOYER_PRIVATE_KEY's address. Confirm owner()
 *      on-chain.
 *   2. Call POST /api/cooperate/validator/grant (owner_signature over
 *      chain + the deployed probe address, EIP-191 personal_sign of the
 *      raw string, the RESOLVED scheme, see backend/src/cleanverse/signature.ts).
 *   3. Call POST /api/cooperate/validator/register for the same address.
 *   4. If register succeeded, set a neutral (no-restriction) RuleV2 via
 *      the probe's setRuleV2FromContract, then call complianceVerify
 *      directly on the validator, read-only, and report a clean bool vs a
 *      revert.
 *
 * Every API call result (success or failure) is printed verbatim: code,
 * message, X-Request-ID. Nothing is fabricated; a failure at any step is
 * reported as-is and the script still attempts the remaining read-only
 * steps where possible, since those are informative regardless.
 *
 * Run with: npx tsx scripts/spike-deploy-register.ts
 * Requires MONAD_TESTNET_RPC, DEPLOYER_PRIVATE_KEY, CLEANVERSE_API_ID,
 * CLEANVERSE_API_KEY, CLEANVERSE_SANDBOX_URL in .env. Never logs the
 * private key or the API key.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { monadTestnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { config as loadDotenv } from "dotenv";

import { loadConfig } from "../src/cleanverse/config.js";
import { CleanverseClient } from "../src/cleanverse/client.js";
import { CleanverseApiError, CleanverseTransportError, CleanverseResponseShapeError } from "../src/cleanverse/errors.js";
import { ownerSignature } from "../src/cleanverse/signature.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
loadDotenv({ path: resolve(REPO_ROOT, ".env") });

const VALIDATOR_ADDRESS = "0xaC7e5179C2C7f03f209136886c172eb34F161792" as const satisfies Address;
const CHAIN_SLUG = "monad";

const VALIDATOR_READ_ABI = parseAbi([
  "function complianceVerify(address poolAddress, address userAddress) external view returns (bool)",
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
  const deployerPk = process.env["DEPLOYER_PRIVATE_KEY"] as Hex | undefined;
  const rpcUrl = process.env["MONAD_TESTNET_RPC"];
  if (!deployerPk) {
    console.error("DEPLOYER_PRIVATE_KEY is not set in .env.");
    process.exitCode = 1;
    return;
  }
  if (!rpcUrl) {
    console.error("MONAD_TESTNET_RPC is not set in .env.");
    process.exitCode = 1;
    return;
  }

  const account = privateKeyToAccount(deployerPk);
  const publicClient = createPublicClient({ chain: monadTestnet, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain: monadTestnet, transport: http(rpcUrl) });

  console.log(`Deployer: ${account.address}`);
  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`Balance: ${balance.toString()} wei`);
  if (balance === 0n) {
    console.error("Deployer balance is 0, cannot deploy. Fund the address first.");
    process.exitCode = 1;
    return;
  }

  // -----------------------------------------------------------------
  // Step 2: deploy MinimalRegistrationProbe.
  // -----------------------------------------------------------------
  const artifactPath = resolve(REPO_ROOT, "contracts/out/MinimalRegistrationProbe.sol/MinimalRegistrationProbe.json");
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as { abi: unknown; bytecode: { object: Hex } };

  console.log("\n=== Step 2: deploying MinimalRegistrationProbe to Monad testnet ===");
  const deployHash = await walletClient.deployContract({
    abi: artifact.abi as never,
    bytecode: artifact.bytecode.object,
    args: [VALIDATOR_ADDRESS, account.address],
  });
  console.log(`Deploy tx: ${deployHash}`);
  const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
  const probeAddress = deployReceipt.contractAddress;
  if (!probeAddress) {
    console.error("Deploy receipt has no contractAddress, deployment failed.");
    console.log(JSON.stringify(deployReceipt, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    process.exitCode = 1;
    return;
  }
  console.log(`Deployed MinimalRegistrationProbe at: ${probeAddress}`);
  console.log(`Deploy status: ${deployReceipt.status}, block ${deployReceipt.blockNumber}`);

  const OWNABLE_READ_ABI = parseAbi(["function owner() external view returns (address)"]);
  const onChainOwner = await publicClient.readContract({
    address: probeAddress,
    abi: OWNABLE_READ_ABI,
    functionName: "owner",
  });
  console.log(`owner() on-chain: ${onChainOwner}`);
  console.log(`Matches deployer (${account.address}): ${onChainOwner.toLowerCase() === account.address.toLowerCase()}`);

  // -----------------------------------------------------------------
  // Step 3: validator/grant, then validator/register.
  // -----------------------------------------------------------------
  console.log("\n=== Step 3: validator/grant ===");
  const cleanverseConfig = loadConfig();
  const client = new CleanverseClient(cleanverseConfig);

  const grantSignature = await ownerSignature(CHAIN_SLUG, probeAddress, account);
  console.log(`owner_signature (grant, over "${CHAIN_SLUG}${probeAddress.toLowerCase()}"): ${grantSignature}`);

  let grantSucceeded = false;
  try {
    const grantResult = await client.validatorGrant({
      chain: CHAIN_SLUG,
      address: probeAddress,
      owner_signature: grantSignature,
    });
    grantSucceeded = true;
    console.log(`  validator/grant: SUCCESS ${JSON.stringify(grantResult)}`);
  } catch (err) {
    reportCleanverseError("validator/grant", err);
  }

  console.log("\n=== Step 3: validator/register ===");
  const registerSignature = await ownerSignature(CHAIN_SLUG, probeAddress, account);
  console.log(`owner_signature (register, over "${CHAIN_SLUG}${probeAddress.toLowerCase()}"): ${registerSignature}`);

  let registerSucceeded = false;
  try {
    const registerResult = await client.validatorRegister({
      chain: CHAIN_SLUG,
      contract_address: probeAddress,
      rule: { allowed_group: "", allowed_sub_group: "", min_tier: 0, min_sub_tier: 0 },
      owner_signature: registerSignature,
    });
    registerSucceeded = true;
    console.log(`  validator/register: SUCCESS ${JSON.stringify(registerResult)}`);
  } catch (err) {
    reportCleanverseError("validator/register", err);
  }

  console.log(`\ngrant succeeded: ${grantSucceeded}, register succeeded: ${registerSucceeded}`);

  // -----------------------------------------------------------------
  // Step 4: if registered, set a neutral RuleV2, then complianceVerify.
  // -----------------------------------------------------------------
  if (registerSucceeded) {
    console.log("\n=== Step 4: setRuleV2FromContract (neutral, no-restriction rule) ===");
    const PROBE_WRITE_ABI = parseAbi([
      "function setRuleV2FromContract((bytes2 allowedGroup, bytes2 allowedSubGroup, uint8 minTier, uint8 minSubTier, uint256 poolCountryBitmap) rule) external",
    ]);
    try {
      const ruleHash = await walletClient.writeContract({
        address: probeAddress,
        abi: PROBE_WRITE_ABI,
        functionName: "setRuleV2FromContract",
        args: [{ allowedGroup: "0x0000", allowedSubGroup: "0x0000", minTier: 0, minSubTier: 0, poolCountryBitmap: 0n }],
      });
      console.log(`setRuleV2FromContract tx: ${ruleHash}`);
      const ruleReceipt = await publicClient.waitForTransactionReceipt({ hash: ruleHash });
      console.log(`setRuleV2FromContract status: ${ruleReceipt.status}`);
    } catch (err) {
      console.log(`setRuleV2FromContract FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    console.log("\n=== Step 4 skipped (register did not succeed), checking complianceVerify anyway for confirmatory data ===");
  }

  console.log("\n=== Step 4: complianceVerify(probe, deployer) on the validator ===");
  try {
    const result = await publicClient.readContract({
      address: VALIDATOR_ADDRESS,
      abi: VALIDATOR_READ_ABI,
      functionName: "complianceVerify",
      args: [probeAddress, account.address],
    });
    console.log(`complianceVerify(${probeAddress}, ${account.address}) = ${result} (CLEAN BOOL, no revert)`);
  } catch (err) {
    console.log(`complianceVerify(${probeAddress}, ${account.address}) REVERTED: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log("\n=== Summary ===");
  console.log(`probeAddress: ${probeAddress}`);
  console.log(`grantSucceeded: ${grantSucceeded}`);
  console.log(`registerSucceeded: ${registerSucceeded}`);
}

main().catch((err) => {
  console.error("spike-deploy-register failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
