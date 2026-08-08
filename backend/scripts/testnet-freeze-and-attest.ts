/**
 * REAL Cleanverse UAT sandbox mutation (update_status, freeze) + real
 * on-chain attestation submission, for the subTier-80 borrower currently
 * holding an open position on the real deployed pool. Separate from
 * testnet-full-lifecycle.ts's "freeze" phase so it can use explicit,
 * generously bumped gas fees, matching what actually landed successfully
 * elsewhere this session under real Monad testnet congestion.
 *
 * Run with: npx tsx scripts/testnet-freeze-and-attest.ts
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
const REGISTRY_ABI = parseAbi([
  "function isCompliant(address user) external view returns (bool)",
  "function isFresh(address user) external view returns (bool)",
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
  const deployments = JSON.parse(readFileSync(resolve(REPO_ROOT, "deployments/testnet.json"), "utf8")) as {
    pool: Address;
    registry: Address;
  };
  const rpcUrl = process.env["MONAD_TESTNET_RPC"]!;
  const borrower = privateKeyToAccount(process.env["TESTNET_BORROWER_HIGH_PRIVATE_KEY"] as Hex);
  const attestor = privateKeyToAccount(process.env["ATTESTOR_PRIVATE_KEY"] as Hex);
  const publicClient = createPublicClient({ chain: monadTestnet, transport: http(rpcUrl) });

  const client = new CleanverseClient(loadConfig());

  console.log("=== complianceVerify BEFORE freeze ===");
  const before = await publicClient.readContract({
    address: VALIDATOR_ADDRESS,
    abi: VALIDATOR_READ_ABI,
    functionName: "complianceVerify",
    args: [deployments.pool, borrower.address],
  });
  console.log(`complianceVerify(pool, borrower) BEFORE freeze = ${before}`);

  console.log("\n=== update_status (real freeze mutation) ===");
  try {
    const result = await client.updateStatus({
      cvRecordId: "1320",
      status: "2",
      wallet: { chain: "monad", address: borrower.address },
    });
    console.log(`update_status: SUCCESS ${JSON.stringify(result)}`);
  } catch (err) {
    reportCleanverseError("update_status", err);
    process.exitCode = 1;
    return;
  }

  console.log("\n=== Re-read query_apass after freeze ===");
  const afterFacts = await client.queryApass({ chain: "monad", address: borrower.address });
  console.log(`query_apass AFTER freeze: ${JSON.stringify(afterFacts)}`);

  console.log("\n=== complianceVerify AFTER freeze ===");
  try {
    const after = await publicClient.readContract({
      address: VALIDATOR_ADDRESS,
      abi: VALIDATOR_READ_ABI,
      functionName: "complianceVerify",
      args: [deployments.pool, borrower.address],
    });
    console.log(`complianceVerify(pool, borrower) AFTER freeze = ${after}`);
  } catch (err) {
    console.log(`complianceVerify AFTER freeze REVERTED: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  }

  console.log("\n=== Post-freeze real attestation (this is what the guardian actually reacts to) ===");
  const factSource = cleanverseFactSource(client, "monad");
  const chainId = await publicClient.getChainId();
  const relay = createAttestationRelay({ rpcUrl, chain: monadTestnet, registryAddress: deployments.registry });
  const domain = buildDomain(chainId, deployments.registry);

  const { attestation, signature } = await attest(
    {
      factSource,
      getNextNonce: relay.getNextNonce,
      now: () => Math.floor(Date.now() / 1000),
      account: attestor,
      domain,
    },
    borrower.address,
  );
  console.log(`attestation to submit: ${JSON.stringify(attestation, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);

  const fees = await publicClient.estimateFeesPerGas();
  const walletClient = createWalletClient({ account: attestor, chain: monadTestnet, transport: http(rpcUrl) });
  const REGISTRY_WRITE_ABI = parseAbi([
    "struct ComplianceAttestation { address user; uint16 tier; uint16 subTier; bytes2 country; uint8 apassStatus; uint256 expiry; uint256 issuedAt; uint256 nonce; }",
    "function submitAttestation(ComplianceAttestation attestation, bytes signature) external",
  ]);
  const hash = await walletClient.writeContract({
    address: deployments.registry,
    abi: REGISTRY_WRITE_ABI,
    functionName: "submitAttestation",
    args: [attestation, signature],
    gas: 300_000n,
    maxFeePerGas: fees.maxFeePerGas * 3n,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas * 3n,
  });
  console.log(`submitAttestation tx: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
  console.log(`submitAttestation status: ${receipt.status}, block ${receipt.blockNumber}`);

  const compliant = await publicClient.readContract({
    address: deployments.registry,
    abi: REGISTRY_ABI,
    functionName: "isCompliant",
    args: [borrower.address],
  });
  const fresh = await publicClient.readContract({
    address: deployments.registry,
    abi: REGISTRY_ABI,
    functionName: "isFresh",
    args: [borrower.address],
  });
  console.log(`\nregistry.isCompliant(borrower) = ${compliant} (expect false)`);
  console.log(`registry.isFresh(borrower) = ${fresh} (expect true)`);
}

main().catch((err) => {
  console.error("testnet-freeze-and-attest failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
