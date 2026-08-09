/**
 * One-time real scan of the deployed LendingPool's full history to
 * discover every address that has ever posted collateral or borrowed.
 * Monad's public testnet RPC caps eth_getLogs at 100 blocks/request (see
 * frontend/src/chain.ts), so a from-genesis scan is genuinely thousands
 * of chunked requests, tens of minutes, not something a page load should
 * ever do from zero. Run this once here, in this environment, and it
 * writes the result straight to frontend/src/data/positions-seed.json,
 * the checkpoint frontend/src/hooks/usePositionsRegistry.ts resumes
 * from, so a fresh browser never re-scans history this script already
 * covered. Real discovered addresses only, nothing fabricated.
 *
 * Run with: npx tsx scripts/scan-all-positions.ts
 */
import { createPublicClient, http, parseAbi, type Address } from "viem";
import { monadTestnet } from "viem/chains";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SEED_PATH = resolve(REPO_ROOT, "frontend/src/data/positions-seed.json");

const client = createPublicClient({ chain: monadTestnet, transport: http("https://testnet-rpc.monad.xyz") });
const POOL = "0x43446f24a860c9c13d138483275b879e16d614dd" as Address;
const DEPLOY_BLOCK = 51825783n;
const CHUNK = 99n;

const abi = parseAbi([
  "event CollateralPosted(address indexed borrower, uint256 amount, uint256 newCollateralBalance)",
  "event Borrow(address indexed borrower, uint256 amount, uint256 newPrincipal, uint256 newDebt, uint16 tier, uint16 subTier, uint16 ratioBps)",
]);

async function main() {
  const current = await client.getBlockNumber();
  const addresses = new Set<string>();
  let from = DEPLOY_BLOCK;
  let chunkCount = 0;
  const start = Date.now();

  while (from <= current) {
    const to = from + CHUNK > current ? current : from + CHUNK;
    let logs;
    try {
      // eslint-disable-next-line no-await-in-loop -- must stay within the RPC's per-request block-range cap, sequential by design
      logs = await client.getLogs({ address: POOL, events: abi, fromBlock: from, toBlock: to });
    } catch (err) {
      console.error(`chunk ${from}-${to} failed: ${err instanceof Error ? err.message : String(err)}, retrying once`);
      // eslint-disable-next-line no-await-in-loop -- deliberate retry backoff
      await new Promise((r) => setTimeout(r, 1000));
      // eslint-disable-next-line no-await-in-loop -- see above
      logs = await client.getLogs({ address: POOL, events: abi, fromBlock: from, toBlock: to });
    }
    for (const log of logs) {
      addresses.add((log.args as { borrower: Address }).borrower.toLowerCase());
    }
    chunkCount++;
    if (chunkCount % 50 === 0) {
      const elapsed = (Date.now() - start) / 1000;
      const pct = (Number(to - DEPLOY_BLOCK) / Number(current - DEPLOY_BLOCK)) * 100;
      console.log(`  ${chunkCount} chunks, block ${to} of ${current} (${pct.toFixed(1)}%), ${addresses.size} addresses, ${elapsed.toFixed(0)}s elapsed`);
    }
    from = to + 1n;
  }

  const result = {
    pool: POOL,
    scannedFrom: DEPLOY_BLOCK.toString(),
    scannedTo: current.toString(),
    generatedAt: new Date().toISOString(),
    addresses: [...addresses],
  };
  writeFileSync(SEED_PATH, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`DONE: ${addresses.size} addresses found, scanned to block ${current}, wrote ${SEED_PATH}`);
}

main().catch((err) => {
  console.error("scan-all-positions failed:", err);
  process.exitCode = 1;
});
