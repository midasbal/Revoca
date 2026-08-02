/**
 * Live, read-only integration test: asserts the keeper's classification
 * logic correctly identifies real UAT sandbox records as ineligible.
 *
 * This hits the live Cleanverse sandbox (query_apass singular), no mock
 * data, per CLAUDE.md. It only reads; it never calls observeCompliance,
 * flag, or any other mutation (no contracts are deployed to call anyway,
 * see docs/OPEN_QUESTIONS.md).
 *
 * The 3 addresses below are the real status:2 (frozen) records surfaced by
 * backend/scripts/status-semantics.ts against the live sandbox on
 * 2026-08-02 (see docs/OPEN_QUESTIONS.md item 7), they are expected to
 * remain frozen in the shared UAT sandbox, but this test reads their LIVE
 * current state each run rather than assuming that snapshot still holds,
 * so it can only assert on what a fresh live call actually reports.
 */
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/cleanverse/config.js";
import { CleanverseClient } from "../src/cleanverse/client.js";
import { loadKeeperConfig } from "../src/keeper/config.js";
import { classifyBorrower } from "../src/keeper/classify.js";
import { cleanverseDataSource } from "../src/keeper/cleanverseSource.js";
import { EligibilityReason } from "../src/keeper/eligibility.js";

const FROZEN_ADDRESSES = [
  "0x7dc22dbd5c7ae7520120c05c7a1d192405fde49b",
  "0x16438e23bae8c6013d2526a5df09523b2d6a1817",
  "0x837d5efb99bdb86bc39fa748077300007565629a",
];

const ACTIVE_ADDRESSES = ["0xa5d56a6a4451d339ed68cc3302bc0bdbb214f0fa", "0x676cbd5978fdeba8c9e55bf122b366f9a1734019"];

const hasCredentials = Boolean(process.env["CLEANVERSE_API_ID"] && process.env["CLEANVERSE_API_KEY"]);

describe.skipIf(!hasCredentials)("keeper classification, live sandbox dry-run", () => {
  const cleanverseConfig = loadConfig();
  const keeperConfig = loadKeeperConfig();
  const client = new CleanverseClient(cleanverseConfig);
  const source = cleanverseDataSource(client, keeperConfig.chain);
  const now = Math.floor(Date.now() / 1000);

  it.each(FROZEN_ADDRESSES)("classifies known-frozen address %s as non-compliant / FROZEN", async (address) => {
    const result = await classifyBorrower(source, address, keeperConfig.poolMinTier, now);

    expect(result.status).toBe(2);
    expect(result.compliant).toBe(false);
    expect(result.reason).toBe(EligibilityReason.FROZEN);
  });

  it.each(ACTIVE_ADDRESSES)("classifies known-active address %s as compliant (for contrast)", async (address) => {
    const result = await classifyBorrower(source, address, keeperConfig.poolMinTier, now);

    expect(result.status).toBe(1);
    expect(result.compliant).toBe(true);
    expect(result.reason).toBe(EligibilityReason.NONE);
  });
});
