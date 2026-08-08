/**
 * DIAGNOSTIC ONLY. Real calls to the live Cleanverse UAT sandbox's
 * /generate_apass, bypassing the typed client so the exact plaintext body
 * sent and the exact raw response received are both visible, to diagnose
 * the "0002 [CV_500]CV System error" hit by testnet-generate-apasses.ts.
 * Tries a few payload variants in order, stops at the first success.
 *
 * Run with: npx tsx scripts/spike-generate-apass-raw.ts <address>
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { config as loadDotenv } from "dotenv";

import { loadConfig } from "../src/cleanverse/config.js";
import { encryptBody } from "../src/cleanverse/crypto.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
loadDotenv({ path: resolve(REPO_ROOT, ".env") });

async function callGenerateApass(cfg: ReturnType<typeof loadConfig>, body: Record<string, unknown>) {
  const url = `${cfg.sandboxUrl}/generate_apass`;
  const requestId = randomUUID();
  const encrypted = encryptBody(body, cfg.apiKey);
  const payload = JSON.stringify({ data: encrypted });

  console.log(`\nX-Request-ID: ${requestId}`);
  console.log(`plaintext body: ${JSON.stringify(body)}`);

  const res = await fetch(url, {
    method: "POST",
    headers: { "api-id": cfg.apiId, "X-Request-ID": requestId, "Content-Type": "application/json" },
    body: payload,
  });

  console.log(`HTTP status: ${res.status} ${res.statusText}`);
  const text = await res.text();
  console.log(`raw response body: ${text}`);
  return text;
}

async function main() {
  const address = process.argv[2];
  if (!address) {
    console.error("usage: spike-generate-apass-raw.ts <address>");
    process.exitCode = 1;
    return;
  }

  const cfg = loadConfig();
  const expirationTime = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;

  const variants: Array<{ label: string; body: Record<string, unknown> }> = [
    {
      label: "A: minimal, no subTier",
      body: { customerId: "revocadiagminA1", expirationTime, wallet: { address, chain: "monad" } },
    },
    {
      label: "B: subTier as string",
      body: { customerId: "revocadiagstrB1", subTier: "80", expirationTime, wallet: { address, chain: "monad" } },
    },
    {
      label: "C: subTier as number",
      body: { customerId: "revocadiagnumC1", subTier: 80, expirationTime, wallet: { address, chain: "monad" } },
    },
    {
      label: "D: PDF's exact example shape (p.12), EVM address, far-future expirationTime",
      body: {
        customerId: "1234561234567892",
        kycSource: "sumsub",
        kycId: "1234567890",
        subTier: 9,
        subGroup: "CD",
        override: false,
        expirationTime: 1863690034,
        wallet: { address, chain: "monad" },
      },
    },
    {
      label: "E: numeric-looking customerId, no optional fields at all",
      body: { customerId: "9876543210987654", expirationTime: 1863690034, wallet: { address, chain: "monad" } },
    },
  ];

  for (const v of variants) {
    console.log(`\n=== Variant ${v.label} ===`);
    const text = await callGenerateApass(cfg, v.body);
    try {
      const parsed = JSON.parse(text);
      if (parsed.code === "0000") {
        console.log(`\n>>> Variant ${v.label} SUCCEEDED, stopping here.`);
        return;
      }
    } catch {
      // fall through, try next variant
    }
  }

  console.log("\nAll variants failed, see raw responses above.");
}

main().catch((err) => {
  console.error("spike-generate-apass-raw failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
