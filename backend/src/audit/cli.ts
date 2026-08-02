/**
 * CLI for the audit report builder (Phase 2c). Reads on-chain event logs
 * for a pool (and optionally scopes to one borrower), reconstructs the
 * compliance-and-unwind history, self-cross-checks against live chain
 * state, and writes both JSON and markdown output. Optionally signs the
 * report with ATTESTOR_PRIVATE_KEY (see docs/AUDIT_REPORT.md Part 3).
 *
 * Usage (from backend/):
 *   npx tsx src/audit/cli.ts --rpc-url http://127.0.0.1:8545 --pool 0x... \
 *     [--borrower 0x...] [--from-block 0] [--to-block latest] \
 *     [--out ./audit-report] [--sign]
 */
import { writeFileSync } from "node:fs";
import { createPublicClient, http, type Address } from "viem";
import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { buildAuditReport } from "./reconstruct.js";
import { renderMarkdown } from "./report.js";
import { signReport } from "./sign.js";
import { attestorAccountFromConfig, loadAttestorConfig } from "../attestor/config.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
loadDotenv({ path: resolve(REPO_ROOT, ".env") });

interface CliArgs {
  rpcUrl: string;
  pool: Address;
  borrower?: Address | undefined;
  fromBlock: bigint;
  toBlock?: bigint | undefined;
  out: string;
  sign: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const get = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };
  const rpcUrl = get("--rpc-url") ?? process.env["MONAD_TESTNET_RPC"];
  const pool = get("--pool") ?? process.env["LENDING_POOL_ADDRESS"];
  if (!rpcUrl) throw new Error("Missing --rpc-url (or MONAD_TESTNET_RPC in .env)");
  if (!pool) throw new Error("Missing --pool (or LENDING_POOL_ADDRESS in .env)");

  const fromBlockRaw = get("--from-block") ?? "0";
  const toBlockRaw = get("--to-block");

  return {
    rpcUrl,
    pool: pool as Address,
    borrower: get("--borrower") as Address | undefined,
    fromBlock: BigInt(fromBlockRaw),
    toBlock: toBlockRaw && toBlockRaw !== "latest" ? BigInt(toBlockRaw) : undefined,
    out: get("--out") ?? "./audit-report",
    sign: argv.includes("--sign"),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const publicClient = createPublicClient({ transport: http(args.rpcUrl) });

  const report = await buildAuditReport({
    publicClient,
    pool: args.pool,
    fromBlock: args.fromBlock,
    toBlock: args.toBlock,
    borrower: args.borrower,
  });

  writeFileSync(`${args.out}.json`, JSON.stringify(report, null, 2));
  writeFileSync(`${args.out}.md`, renderMarkdown(report));
  console.log(`Wrote ${args.out}.json and ${args.out}.md`);
  console.log(`Overall cross-check: ${report.crossCheckOk ? "PASS" : "FAIL"}`);

  if (args.sign) {
    const account = attestorAccountFromConfig(loadAttestorConfig());
    const signed = await signReport(account, report);
    writeFileSync(`${args.out}.signed.json`, JSON.stringify(signed, null, 2));
    console.log(`Signed by ${signed.signer}, wrote ${args.out}.signed.json`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
