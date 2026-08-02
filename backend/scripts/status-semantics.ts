/**
 * Live, read-only investigation: does query_apass (singular) return an
 * authoritative status where query_apass_list returned null?
 *
 * Finds the first 3 status:2 (frozen) and first 2 status:1 (active)
 * records from query_apass_list (chain "monad", paginated), then calls
 * query_apass on each of those addresses and compares status/tier/subTier/
 * expirationTime between the two endpoints.
 *
 * Per docs/CLEANVERSE_API.md (cross-checked against docs/cleanverse.pdf
 * p.111-114): query_apass is `POST /query_apass`, plain JSON, request
 * fields `chain` + `address` (not walletAddress, confirmed distinct from
 * query_apass_list's request shape). Response data: cvRecordId, subTier,
 * tier, status, expirationTime, subGroup, currentKycHash, group, countries.
 * No walletAddress/chain/txHash in the singular response (see
 * docs/CLEANVERSE_API.md's query_apass section for why).
 *
 * Run with: npm run status-semantics
 */
import { loadConfig } from "../src/cleanverse/config.js";
import { CleanverseClient } from "../src/cleanverse/client.js";
import type { ApassListItem, QueryApassData } from "../src/cleanverse/types.js";

const MAX_PAGE_SIZE = 100;

async function findSampleRecords(
  client: CleanverseClient,
  chain: string,
): Promise<{ frozen: ApassListItem[]; active: ApassListItem[] }> {
  const frozen: ApassListItem[] = [];
  const active: ApassListItem[] = [];
  let page = 1;
  const MAX_PAGES = 1000;

  while (page <= MAX_PAGES && (frozen.length < 3 || active.length < 2)) {
    const resp = await client.queryApassList({ chain, page, pageSize: MAX_PAGE_SIZE });
    for (const item of resp.items) {
      if (item.status === 2 && frozen.length < 3) frozen.push(item);
      if (item.status === 1 && active.length < 2) active.push(item);
    }
    if (resp.items.length === 0 || page * MAX_PAGE_SIZE >= resp.total) break;
    page++;
  }

  return { frozen, active };
}

interface Comparison {
  label: string;
  address: string;
  listSide: Pick<ApassListItem, "status" | "tier" | "subTier" | "expirationTime">;
  singularSide: QueryApassData | { error: string };
}

async function main() {
  const config = loadConfig();
  const client = new CleanverseClient(config);

  console.log("Finding sample frozen/active records via query_apass_list (chain=monad)...\n");
  const { frozen, active } = await findSampleRecords(client, "monad");

  console.log(`Found ${frozen.length} frozen (status:2), ${active.length} active (status:1) sample records.\n`);

  const comparisons: Comparison[] = [];

  for (const item of [...frozen.map((f) => ({ item: f, label: "frozen" })), ...active.map((a) => ({ item: a, label: "active" }))]) {
    const address = item.item.walletAddress;
    let singularSide: QueryApassData | { error: string };
    try {
      singularSide = await client.queryApass({ chain: "monad", address });
    } catch (err) {
      singularSide = { error: err instanceof Error ? err.message : String(err) };
    }
    comparisons.push({
      label: item.label,
      address,
      listSide: {
        status: item.item.status,
        tier: item.item.tier,
        subTier: item.item.subTier,
        expirationTime: item.item.expirationTime,
      },
      singularSide,
    });
  }

  console.log("=== Comparison: query_apass_list vs query_apass (singular) ===\n");
  for (const c of comparisons) {
    console.log(`--- [${c.label}] ${c.address} ---`);
    console.log(`  list:      status=${c.listSide.status} tier=${c.listSide.tier} subTier=${c.listSide.subTier} expirationTime=${c.listSide.expirationTime}`);
    if ("error" in c.singularSide) {
      console.log(`  singular:  ERROR, ${c.singularSide.error}`);
    } else {
      console.log(
        `  singular:  status=${c.singularSide.status} tier=${c.singularSide.tier} subTier=${c.singularSide.subTier} expirationTime=${c.singularSide.expirationTime}`,
      );
    }
    console.log("");
  }
}

main().catch((err) => {
  console.error("status-semantics script failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
