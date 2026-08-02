/**
 * Keeper dry-run: classifies real sandbox addresses via live `query_apass`
 * (SINGULAR, never mock data) and logs the on-chain actions the keeper
 * WOULD take, without sending any transaction or touching an RPC at all.
 *
 * No contracts are deployed on Monad testnet yet this session (see
 * docs/OPEN_QUESTIONS.md), so this script exercises exactly the part that
 * doesn't need them: live classification (classifyBorrower) plus a
 * simulated state-machine decision assuming each address starts from
 * RevocationGuardian's HEALTHY state (the only assumption this script
 * makes, everything about the classification itself is real). Once
 * contracts are deployed, `backend/src/keeper/poller.ts`'s `pollOnce`
 * supersedes this script's simulated decision step with real on-chain
 * reads via OnChainDriver.
 *
 * Run with: npm run keeper:dry-run
 */
import { loadConfig } from "../src/cleanverse/config.js";
import { CleanverseClient } from "../src/cleanverse/client.js";
import { loadKeeperConfig } from "../src/keeper/config.js";
import { classifyBorrower, type BorrowerClassification } from "../src/keeper/classify.js";
import { cleanverseDataSource } from "../src/keeper/cleanverseSource.js";
import { EligibilityReason } from "../src/keeper/eligibility.js";

// The 3 real status:2 (frozen) records surfaced by
// backend/scripts/status-semantics.ts against the live UAT sandbox on
// 2026-08-02 (see docs/OPEN_QUESTIONS.md item 7), plus the 2 active ones
// from the same run for contrast.
const FROZEN_ADDRESSES = [
  "0x7dc22dbd5c7ae7520120c05c7a1d192405fde49b",
  "0x16438e23bae8c6013d2526a5df09523b2d6a1817",
  "0x837d5efb99bdb86bc39fa748077300007565629a",
];

const ACTIVE_ADDRESSES = ["0xa5d56a6a4451d339ed68cc3302bc0bdbb214f0fa", "0x676cbd5978fdeba8c9e55bf122b366f9a1734019"];

function reasonName(reason: EligibilityReason): string {
  return EligibilityReason[reason] ?? "UNKNOWN";
}

function describeIntendedActions(c: BorrowerClassification): string[] {
  const actions: string[] = [
    `submitAttestation(${c.address}, tier=${c.tier ?? "null"}, subTier=${c.subTier ?? "null"}, apassStatus=${c.status ?? "null"})  // facts only; on-chain eligibility (compliant=${c.compliant}, reason=${reasonName(c.reason)}) is derived from these facts + CompliancePolicy, never attested directly`,
  ];
  // Simulated decision assuming HEALTHY starting state (see header), this
  // is the ONE non-live assumption in this script.
  if (!c.compliant) {
    actions.push(`flag(${c.address})  // registry would show compliant=false`);
  } else {
    actions.push(`(no guardian action, compliant, assumed-healthy position needs no flag)`);
  }
  return actions;
}

async function main() {
  const cleanverseConfig = loadConfig();
  const keeperConfig = loadKeeperConfig();
  const client = new CleanverseClient(cleanverseConfig);
  const source = cleanverseDataSource(client, keeperConfig.chain);
  const now = Math.floor(Date.now() / 1000);

  console.log(`Keeper dry-run, chain=${keeperConfig.chain}, poolMinTier=${keeperConfig.poolMinTier}, now=${now}\n`);

  const all = [
    ...FROZEN_ADDRESSES.map((a) => ({ address: a, label: "known frozen (status:2)" })),
    ...ACTIVE_ADDRESSES.map((a) => ({ address: a, label: "known active (status:1)" })),
  ];

  for (const { address, label } of all) {
    console.log(`--- ${address} (${label}) ---`);
    try {
      const classification = await classifyBorrower(source, address, keeperConfig.poolMinTier, now);
      console.log(
        `  live query_apass: status=${classification.status} tier=${classification.tier} subTier=${classification.subTier} expirationTime=${classification.expirationTime}`,
      );
      console.log(`  classification:   compliant=${classification.compliant} reason=${reasonName(classification.reason)}`);
      console.log(`  intended actions (dry-run, not sent):`);
      for (const action of describeIntendedActions(classification)) {
        console.log(`    - ${action}`);
      }
    } catch (err) {
      console.log(`  ERROR classifying: ${err instanceof Error ? err.message : String(err)}`);
    }
    console.log("");
  }
}

main().catch((err) => {
  console.error("keeper-dry-run failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
