/**
 * REAL Cleanverse UAT sandbox mutation. Generates real A-Passes for three
 * fresh Monad testnet wallets we control, then verifies each one via
 * query_apass (singular), never trusting generate_apass's success response
 * alone, per docs/OPEN_QUESTIONS.md's confirmed gotcha: subTier must be
 * sent as a STRING, or it is silently ignored despite a "0000" success
 * response with a real tx hash.
 *
 * `tier` is NOT a generate_apass request field at all (only subTier/
 * subGroup are caller-controlled, confirmed by re-reading
 * docs/CLEANVERSE_API.md's generate_apass section), so unlike subTier,
 * whatever `tier` these A-Passes get assigned is discovered empirically
 * from the query_apass readback, never assumed or forced.
 *
 * No KYC source/ID fields are sent (not required during the hackathon, per
 * docs/OPEN_QUESTIONS.md's confirmed facts).
 *
 * Outputs:
 *   - Fresh private keys appended to .env (never printed, never logged).
 *   - Public results (address, customerId, cvRecordId, verified
 *     tier/subTier/status/expirationTime) written to
 *     deployments/testnet-apasses.json (gitignored, no secrets).
 *
 * Run with: npx tsx scripts/testnet-generate-apasses.ts
 * Requires CLEANVERSE_API_ID, CLEANVERSE_API_KEY, CLEANVERSE_SANDBOX_URL in .env.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { loadConfig } from "../src/cleanverse/config.js";
import { CleanverseClient } from "../src/cleanverse/client.js";
import { CleanverseApiError, CleanverseTransportError, CleanverseResponseShapeError } from "../src/cleanverse/errors.js";
import type { GenerateApassParams, QueryApassData } from "../src/cleanverse/types.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ENV_PATH = resolve(REPO_ROOT, ".env");
const OUTPUT_PATH = resolve(REPO_ROOT, "deployments/testnet-apasses.json");

interface Role {
  label: "high" | "mid" | "freeze";
  envVar: string;
  customerId: string;
  /** Intended subTier, sent as a STRING per the confirmed gotcha. */
  subTier: string;
}

const ROLES: Role[] = [
  { label: "high", envVar: "TESTNET_BORROWER_HIGH_PRIVATE_KEY", customerId: "revocahightier01", subTier: "80" },
  { label: "mid", envVar: "TESTNET_BORROWER_MID_PRIVATE_KEY", customerId: "revocamidtier001", subTier: "20" },
  { label: "freeze", envVar: "TESTNET_BORROWER_FREEZE_PRIVATE_KEY", customerId: "revocafreezedm01", subTier: "80" },
];

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

/** Appends KEY=0x... to .env only if KEY isn't already set there. Never logs the value. */
function persistSecretToEnv(key: string, value: string): void {
  const existing = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  // A bare "KEY=" placeholder line (e.g. from .env.example) has the key
  // NAME present but an EMPTY value, that must be filled in, not skipped,
  // or a freshly generated secret that was already used on-chain/off-chain
  // this run gets silently discarded and lost. Only a line with a real,
  // non-empty value counts as "already configured."
  if (new RegExp(`^${key}=.+$`, "m").test(existing)) {
    console.log(`  .env already has a non-empty ${key}, leaving it as-is`);
    return;
  }
  const blankLinePattern = new RegExp(`^${key}=\\s*$`, "m");
  if (blankLinePattern.test(existing)) {
    writeFileSync(ENV_PATH, existing.replace(blankLinePattern, `${key}=${value}`));
    console.log(`  filled in blank ${key} placeholder in .env (value not logged)`);
    return;
  }
  appendFileSync(ENV_PATH, `${existing.endsWith("\n") || existing === "" ? "" : "\n"}${key}=${value}\n`);
  console.log(`  wrote ${key} to .env (value not logged)`);
}

async function main() {
  const config = loadConfig();
  const client = new CleanverseClient(config);

  const expirationTime = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;

  const results: Array<{
    label: string;
    address: string;
    customerId: string;
    generateApass: { succeeded: boolean; cvRecordId: string | undefined };
    verified: QueryApassData | null;
    subTierMatchesIntent: boolean | null;
  }> = [];

  for (const role of ROLES) {
    console.log(`\n=== ${role.label}: generating fresh wallet + real A-Pass ===`);
    const pk = generatePrivateKey();
    const account = privateKeyToAccount(pk);
    console.log(`  address: ${account.address}`);
    persistSecretToEnv(role.envVar, pk);

    const params = {
      customerId: role.customerId,
      subTier: role.subTier,
      expirationTime,
      wallet: { address: account.address, chain: "monad" },
    } as GenerateApassParams;

    let generateSucceeded = false;
    let cvRecordId: string | undefined;
    try {
      const result = await client.generateApass(params);
      generateSucceeded = true;
      cvRecordId = result.cvRecordId;
      console.log(`  generate_apass: SUCCESS customerId=${result.customerId} cvRecordId=${result.cvRecordId}`);
    } catch (err) {
      reportCleanverseError("generate_apass", err);
    }

    let verified: QueryApassData | null = null;
    let subTierMatchesIntent: boolean | null = null;
    if (generateSucceeded) {
      try {
        verified = await client.queryApass({ chain: "monad", address: account.address });
        subTierMatchesIntent = String(verified.subTier) === role.subTier;
        console.log(
          `  query_apass (singular) VERIFIED: tier=${verified.tier} subTier=${verified.subTier} status=${verified.status} expirationTime=${verified.expirationTime}`,
        );
        console.log(
          `  subTier matches intent (${role.subTier}): ${subTierMatchesIntent} ${subTierMatchesIntent ? "" : "<<< SILENT-IGNORE GOTCHA HIT, see docs/OPEN_QUESTIONS.md"}`,
        );
      } catch (err) {
        reportCleanverseError("query_apass (verify)", err);
      }
    }

    results.push({
      label: role.label,
      address: account.address,
      customerId: role.customerId,
      generateApass: { succeeded: generateSucceeded, cvRecordId },
      verified,
      subTierMatchesIntent,
    });
  }

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
  console.log(`\nWrote public (non-secret) results to ${OUTPUT_PATH}`);

  console.log("\n=== Summary ===");
  for (const r of results) {
    console.log(
      `${r.label.padEnd(7)} ${r.address} tier=${r.verified?.tier ?? "N/A"} subTier=${r.verified?.subTier ?? "N/A"} status=${r.verified?.status ?? "N/A"} subTierOk=${r.subTierMatchesIntent}`,
    );
  }
}

main().catch((err) => {
  console.error("testnet-generate-apasses failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
