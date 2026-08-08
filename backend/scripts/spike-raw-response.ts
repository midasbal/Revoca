/**
 * SPIKE / PROBE, DIAGNOSTIC ONLY. Real call to the live Cleanverse UAT
 * sandbox, same endpoint and same signed payload
 * spike-deploy-register.ts uses, but bypasses CleanverseClient's
 * encrypted-response assumption to print the RAW JSON envelope Cleanverse
 * actually returned. Exists only because the typed client's
 * CleanverseResponseShapeError ("expected encrypted data to be a base64
 * string, got object") hides the actual object content, and that content
 * is real diagnostic information for docs/DESIGN_A_SPIKE.md, not
 * something to guess at.
 *
 * Run with: npx tsx scripts/spike-raw-response.ts <grant|register>
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";

import { loadConfig } from "../src/cleanverse/config.js";
import { encryptBody } from "../src/cleanverse/crypto.js";
import { ownerSignature } from "../src/cleanverse/signature.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
loadDotenv({ path: resolve(REPO_ROOT, ".env") });

const CHAIN_SLUG = "monad";

async function main() {
  const which = process.argv[2];
  if (which !== "grant" && which !== "register") {
    console.error("usage: spike-raw-response.ts <grant|register>");
    process.exitCode = 1;
    return;
  }

  const probeAddress = process.argv[3] as Address | undefined;
  if (!probeAddress) {
    console.error("usage: spike-raw-response.ts <grant|register> <probeAddress>");
    process.exitCode = 1;
    return;
  }

  const deployerPk = process.env["DEPLOYER_PRIVATE_KEY"] as Hex | undefined;
  if (!deployerPk) {
    console.error("DEPLOYER_PRIVATE_KEY not set");
    process.exitCode = 1;
    return;
  }
  const account = privateKeyToAccount(deployerPk);
  const cfg = loadConfig();

  const signature = await ownerSignature(CHAIN_SLUG, probeAddress, account);

  const body =
    which === "grant"
      ? { chain: CHAIN_SLUG, address: probeAddress, owner_signature: signature }
      : {
          chain: CHAIN_SLUG,
          contract_address: probeAddress,
          rule: { allowed_group: "", allowed_sub_group: "", min_tier: 0, min_sub_tier: 0 },
          owner_signature: signature,
        };

  const path = which === "grant" ? "/validator/grant" : "/validator/register";
  const url = `${cfg.sandboxUrl}${path}`;
  const requestId = randomUUID();

  const encrypted = encryptBody(body, cfg.apiKey);
  const payload = JSON.stringify({ data: encrypted });

  console.log(`POST ${url}`);
  console.log(`X-Request-ID: ${requestId}`);
  console.log(`plaintext body: ${JSON.stringify(body)}`);
  console.log("");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "api-id": cfg.apiId,
      "X-Request-ID": requestId,
      "Content-Type": "application/json",
    },
    body: payload,
  });

  console.log(`HTTP status: ${res.status} ${res.statusText}`);
  const text = await res.text();
  console.log(`raw response body: ${text}`);
}

main().catch((err) => {
  console.error("spike-raw-response failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
