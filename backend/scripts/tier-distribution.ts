/**
 * Live, read-only tier-distribution analysis against the Cleanverse UAT
 * sandbox. Paginates query_apass_list (chain "monad") to exhaustion and
 * reports the real distribution of tier, subTier, status, and expiration
 * found in the sandbox's actual A-Pass records, this is what grounds
 * backend/src/risk/tierRatios.ts, not invented tier buckets.
 *
 * Per docs/CLEANVERSE_API.md (cross-checked against docs/cleanverse.pdf):
 * query_apass_list request fields are all optional (customerId, chain,
 * walletAddress, status, page, pageSize [default 20, max 100], createdFrom,
 * createdTo); response is { total, page, pageSize, items[] } with each item
 * carrying status (1 active / 2 frozen, but see the null-status note below),
 * tier, subTier, expirationTime (unix seconds), etc.
 *
 * Run with: npm run tier-distribution
 */
import { loadConfig } from "../src/cleanverse/config.js";
import { CleanverseClient } from "../src/cleanverse/client.js";
import type { ApassListItem } from "../src/cleanverse/types.js";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const MAX_PAGE_SIZE = 100; // per docs/CLEANVERSE_API.md, query_apass_list pageSize max is 100

async function fetchAllApassRecords(client: CleanverseClient, chain: string): Promise<ApassListItem[]> {
  const all: ApassListItem[] = [];
  let page = 1;
  // Safety cap so a pagination bug (e.g. `total` never satisfied) can't loop forever.
  const MAX_PAGES = 1000;

  while (page <= MAX_PAGES) {
    const resp = await client.queryApassList({ chain, page, pageSize: MAX_PAGE_SIZE });
    all.push(...resp.items);
    if (resp.items.length === 0 || all.length >= resp.total) break;
    page++;
  }

  return all;
}

interface Distribution {
  total: number;
  byTier: Record<string, number>;
  bySubTier: Record<string, number>;
  byStatus: { active: number; frozen: number; nullOrUnknown: number };
  byExpiration: { past: number; future: number; missing: number };
}

function analyze(items: ApassListItem[], nowUnixSeconds: number): Distribution {
  const byTier: Record<string, number> = {};
  const bySubTier: Record<string, number> = {};
  let active = 0;
  let frozen = 0;
  let nullOrUnknown = 0;
  let past = 0;
  let future = 0;
  let missing = 0;

  for (const item of items) {
    const tierKey = item.tier ?? "<null>";
    byTier[tierKey] = (byTier[tierKey] ?? 0) + 1;

    const subTierKey = String(item.subTier ?? "<null>");
    bySubTier[subTierKey] = (bySubTier[subTierKey] ?? 0) + 1;

    if (item.status === 1) active++;
    else if (item.status === 2) frozen++;
    else nullOrUnknown++;

    if (item.expirationTime === undefined || item.expirationTime === null) {
      missing++;
    } else if (item.expirationTime < nowUnixSeconds) {
      past++;
    } else {
      future++;
    }
  }

  return {
    total: items.length,
    byTier,
    bySubTier,
    byStatus: { active, frozen, nullOrUnknown },
    byExpiration: { past, future, missing },
  };
}

function sortedEntries(record: Record<string, number>): [string, number][] {
  return Object.entries(record).sort((a, b) => {
    const na = Number(a[0]);
    const nb = Number(b[0]);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
    return a[0].localeCompare(b[0]);
  });
}

function renderTable(title: string, rows: [string, number][], total: number): string {
  const lines = [title, "-".repeat(title.length)];
  for (const [key, count] of rows) {
    const pct = total > 0 ? ((count / total) * 100).toFixed(1) : "0.0";
    lines.push(`  ${key.padEnd(12)} ${String(count).padStart(6)}  (${pct}%)`);
  }
  return lines.join("\n");
}

function renderMarkdownTable(rows: [string, number][], total: number, keyLabel: string): string {
  const header = `| ${keyLabel} | count | % |\n|---|---|---|`;
  const body = rows
    .map(([key, count]) => `| ${key} | ${count} | ${total > 0 ? ((count / total) * 100).toFixed(1) : "0.0"}% |`)
    .join("\n");
  return `${header}\n${body}`;
}

async function main() {
  const config = loadConfig();
  const client = new CleanverseClient(config);

  console.log("Fetching all A-Pass records for chain=monad via query_apass_list (paginated)...\n");
  const items = await fetchAllApassRecords(client, "monad");
  const nowUnixSeconds = Math.floor(Date.now() / 1000);
  const dist = analyze(items, nowUnixSeconds);

  console.log(`Total records fetched: ${dist.total}\n`);
  console.log(renderTable("Tier distribution", sortedEntries(dist.byTier), dist.total));
  console.log("");
  console.log(renderTable("SubTier distribution", sortedEntries(dist.bySubTier), dist.total));
  console.log("");
  console.log("Status distribution");
  console.log("--------------------");
  console.log(`  active (1)          ${String(dist.byStatus.active).padStart(6)}`);
  console.log(`  frozen (2)          ${String(dist.byStatus.frozen).padStart(6)}`);
  console.log(`  null/unknown status ${String(dist.byStatus.nullOrUnknown).padStart(6)}`);
  console.log("");
  console.log("Expiration distribution (relative to now)");
  console.log("------------------------------------------");
  console.log(`  expired (past)      ${String(dist.byExpiration.past).padStart(6)}`);
  console.log(`  not yet expired     ${String(dist.byExpiration.future).padStart(6)}`);
  console.log(`  missing expiration  ${String(dist.byExpiration.missing).padStart(6)}`);

  const nowIso = new Date(nowUnixSeconds * 1000).toISOString();
  const markdown = `# Tier distribution, live sandbox snapshot

Generated by \`backend/scripts/tier-distribution.ts\` against the Cleanverse
UAT sandbox (\`query_apass_list\`, \`chain: "monad"\`, fully paginated). This is
real data from the sandbox's actual A-Pass records, not invented tiers, and
is what grounds \`backend/src/risk/tierRatios.ts\`'s collateral-ratio table.

Snapshot taken: ${nowIso} (unix ${nowUnixSeconds})

Total records: **${dist.total}**

## Tier distribution

${renderMarkdownTable(sortedEntries(dist.byTier), dist.total, "tier")}

## SubTier distribution

${renderMarkdownTable(sortedEntries(dist.bySubTier), dist.total, "subTier")}

## Status distribution

Per docs/CLEANVERSE_API.md: \`status\` is documented as \`1\` = active, \`2\` =
frozen. In practice, a large share of live sandbox records have \`status:
null\` rather than \`1\` or \`2\`, likely records created via a flow that
doesn't set status explicitly (e.g. legacy/demo records seeded by other
hackathon participants' institutions, since \`query_apass_list\` resolves
every record tied to our shared \`api-id\`'s institution). This is a real
observation about the sandbox data, not a client bug, see
docs/OPEN_QUESTIONS.md for how this affects the "can we force a real
freeze" spike (item 3).

| status | count | % |
|---|---|---|
| active (1) | ${dist.byStatus.active} | ${dist.total > 0 ? ((dist.byStatus.active / dist.total) * 100).toFixed(1) : "0.0"}% |
| frozen (2) | ${dist.byStatus.frozen} | ${dist.total > 0 ? ((dist.byStatus.frozen / dist.total) * 100).toFixed(1) : "0.0"}% |
| null/unknown | ${dist.byStatus.nullOrUnknown} | ${dist.total > 0 ? ((dist.byStatus.nullOrUnknown / dist.total) * 100).toFixed(1) : "0.0"}% |

## Expiration distribution (relative to snapshot time above)

| bucket | count | % |
|---|---|---|
| expired (past) | ${dist.byExpiration.past} | ${dist.total > 0 ? ((dist.byExpiration.past / dist.total) * 100).toFixed(1) : "0.0"}% |
| not yet expired | ${dist.byExpiration.future} | ${dist.total > 0 ? ((dist.byExpiration.future / dist.total) * 100).toFixed(1) : "0.0"}% |
| missing expirationTime | ${dist.byExpiration.missing} | ${dist.total > 0 ? ((dist.byExpiration.missing / dist.total) * 100).toFixed(1) : "0.0"}% |

## Notes for tier-to-risk design

- \`tier\` in this sandbox is a numeric-looking **string** field (e.g.
  \`"50"\`), not the 0-99 integer range documented for \`min_tier\` in the
  Validator Compliance Rule object. Confirm whether \`query_apass\`/\`_list\`'s
  \`tier\` and the Rule object's \`min_tier\` are the same numeric space before
  wiring a pool's collateral table directly to this field, see
  \`backend/src/risk/tierRatios.ts\`'s header comment for how this was
  handled.
- \`subTier\` is a genuine integer and spans the range shown above.
`;

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const docsPath = resolve(scriptDir, "../../docs/TIER_DISTRIBUTION.md");
  writeFileSync(docsPath, markdown, "utf8");
  console.log(`\nWrote findings to ${docsPath}`);
}

main().catch((err) => {
  console.error("tier-distribution script failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
