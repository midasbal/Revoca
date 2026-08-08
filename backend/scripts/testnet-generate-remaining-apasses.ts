/**
 * REAL Cleanverse UAT sandbox mutation. Generates the remaining three
 * A-Passes for the tier-as-risk demo spread (see docs/OPEN_QUESTIONS.md's
 * tier-spread investigation): tier is auto-assigned by Cleanverse (not
 * caller-controllable, confirmed empirically), so the spread comes purely
 * from subTier, which IS caller-controllable. Reuses the already-verified
 * subTier "80" wallet (TESTNET_BORROWER_HIGH_PRIVATE_KEY) rather than
 * regenerating it.
 *
 * Each generation is verified via query_apass (singular), never trusting
 * generate_apass's success response alone, per the confirmed
 * silent-ignore gotcha (docs/OPEN_QUESTIONS.md).
 *
 * Run with: npx tsx scripts/testnet-generate-remaining-apasses.ts
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

import { loadConfig } from "../src/cleanverse/config.js";
import { CleanverseClient } from "../src/cleanverse/client.js";
import { CleanverseApiError, CleanverseTransportError, CleanverseResponseShapeError } from "../src/cleanverse/errors.js";
import type { GenerateApassParams, QueryApassData } from "../src/cleanverse/types.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ENV_PATH = resolve(REPO_ROOT, ".env");
const OUTPUT_PATH = resolve(REPO_ROOT, "deployments/testnet-apasses.json");

interface Role {
  label: string;
  envVar: string;
  customerId: string;
  subTier: string;
  /** If set, reuse this existing wallet instead of generating a fresh one. */
  reuseEnvVar?: string;
}

const ROLES: Role[] = [
  { label: "high (80)", envVar: "TESTNET_BORROWER_HIGH_PRIVATE_KEY", customerId: "n/a", subTier: "80", reuseEnvVar: "TESTNET_BORROWER_HIGH_PRIVATE_KEY" },
  { label: "mid-high (50)", envVar: "TESTNET_BORROWER_MIDHIGH_PRIVATE_KEY", customerId: "revocamidhigh501", subTier: "50" },
  { label: "mid-low (20)", envVar: "TESTNET_BORROWER_MIDLOW_PRIVATE_KEY", customerId: "revocamidlow2001", subTier: "20" },
  { label: "low (1)", envVar: "TESTNET_BORROWER_LOW_PRIVATE_KEY", customerId: "revocalowtier001", subTier: "1" },
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
    verified: QueryApassData | null;
    subTierMatchesIntent: boolean | null;
  }> = [];

  for (const role of ROLES) {
    console.log(`\n=== ${role.label} ===`);

    let pk: Hex;
    if (role.reuseEnvVar) {
      const existing = process.env[role.reuseEnvVar] as Hex | undefined;
      if (!existing) {
        console.log(`  ${role.reuseEnvVar} not set, skipping reuse, cannot proceed for this role.`);
        continue;
      }
      pk = existing;
      console.log(`  reusing existing wallet from ${role.reuseEnvVar}`);
    } else {
      pk = generatePrivateKey();
      persistSecretToEnv(role.envVar, pk);
    }
    const account = privateKeyToAccount(pk);
    console.log(`  address: ${account.address}`);

    if (!role.reuseEnvVar) {
      const params = {
        customerId: role.customerId,
        subTier: role.subTier,
        expirationTime,
        wallet: { address: account.address, chain: "monad" },
      } as GenerateApassParams;

      try {
        const result = await client.generateApass(params);
        console.log(`  generate_apass: SUCCESS customerId=${result.customerId} cvRecordId=${result.cvRecordId} tier=${(result as unknown as { tier?: string }).tier ?? "n/a"}`);
      } catch (err) {
        reportCleanverseError("generate_apass", err);
        results.push({ label: role.label, address: account.address, verified: null, subTierMatchesIntent: null });
        continue;
      }
    }

    let verified: QueryApassData | null = null;
    let subTierMatchesIntent: boolean | null = null;
    try {
      verified = await client.queryApass({ chain: "monad", address: account.address });
      subTierMatchesIntent = String(verified.subTier) === role.subTier;
      console.log(
        `  query_apass (singular) VERIFIED: tier=${verified.tier} subTier=${verified.subTier} status=${verified.status} expirationTime=${verified.expirationTime}`,
      );
      console.log(`  subTier matches intent (${role.subTier}): ${subTierMatchesIntent}`);
    } catch (err) {
      reportCleanverseError("query_apass (verify)", err);
    }

    results.push({ label: role.label, address: account.address, verified, subTierMatchesIntent });
  }

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
  console.log(`\nWrote ${OUTPUT_PATH}`);

  console.log("\n=== Summary ===");
  for (const r of results) {
    console.log(
      `${r.label.padEnd(14)} ${r.address} tier=${r.verified?.tier ?? "N/A"} subTier=${r.verified?.subTier ?? "N/A"} status=${r.verified?.status ?? "N/A"} subTierOk=${r.subTierMatchesIntent}`,
    );
  }
}

main().catch((err) => {
  console.error("testnet-generate-remaining-apasses failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
