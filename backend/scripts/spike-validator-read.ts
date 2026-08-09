/**
 * SPIKE / PROBE SCRIPT. Not part of the real keeper/attestor/audit paths.
 *
 * Read-only on-chain check of whether Cleanverse's CVI Compliance
 * Validator (IAPassComplianceValidator, see
 * contracts/src/spike/IAPassComplianceValidator.sol, also a spike file)
 * actually exists and responds on Monad testnet. Calls only plain `view`
 * functions that the CCP Integration Guide (docs/cleanverse2.pdf, gated,
 * gitignored) documents as requiring no permission: `isRegistered` and
 * `complianceVerify`. No private key needed, no transaction sent, nothing
 * deployed.
 *
 * The point is narrow: does the contract at the documented address
 * (0xaC7e5179C2C7f03f209136886c172eb34F161792, per Cleanverse's Telegram
 * announcement, the same address on every chain) exist and respond with a
 * real value on Monad, independent of whether OUR registration would ever
 * succeed. A revert with no code (nothing deployed there), a revert with a
 * reason, and a clean boolean response are three genuinely different
 * findings and are recorded as such, never collapsed into a fabricated
 * "it works" or "it doesn't."
 *
 * Run with: npx tsx scripts/spike-validator-read.ts
 * Requires MONAD_TESTNET_RPC in .env. No other env var needed.
 */
import { createPublicClient, http, parseAbi, type Address } from "viem";
import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
loadDotenv({ path: resolve(REPO_ROOT, ".env") });

const VALIDATOR_ADDRESS = "0xaC7e5179C2C7f03f209136886c172eb34F161792" as const satisfies Address;

// Only the two no-permission-required view functions from the guide's 3.2,
// exactly matching contracts/src/spike/IAPassComplianceValidator.sol.
const VALIDATOR_READ_ABI = parseAbi([
  "function isRegistered(address poolAddress) external view returns (bool)",
  "function complianceVerify(address poolAddress, address userAddress) external view returns (bool)",
]);

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const satisfies Address;

/**
 * A real address surfaced by an earlier live query_apass_list probe
 * (see scripts/probe.ts's CANDIDATE_POOL_ADDR), customerId
 * "CCPOOLV20001MONAD" ("CCP" matching our Validator Compliance/CCP
 * mapping), plausibly a real Monad-related pool. Used as a second
 * candidate so a "false"/revert against the zero address alone can't be
 * mistaken for "nothing is registered anywhere."
 */
const CANDIDATE_POOL_ADDR = "0xEA459EB91F7Dc1fF866282C1E80b9fdE7C4b297d" as const satisfies Address;

interface ProbeOutcome {
  call: string;
  outcome: "value" | "revert-with-reason" | "revert-no-reason" | "network-error";
  detail: string;
}

async function readOne(
  _client: ReturnType<typeof createPublicClient>,
  label: string,
  fn: () => Promise<unknown>,
): Promise<ProbeOutcome> {
  try {
    const value = await fn();
    return { call: label, outcome: "value", detail: JSON.stringify(value) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // viem's ContractFunctionRevertedError / ContractFunctionExecutionError
    // carry a shortMessage and, for EVM reverts, a decoded reason where
    // available. We don't try to be clever about classifying further than
    // "has a reason string in the error" vs not, real text either way,
    // never fabricated.
    const hasReasonText = /revert|Revert|reason/i.test(message);
    // Full message, not just the first line, the useful diagnostic detail
    // (decoded custom error name, or the raw selector/data) is usually a
    // few lines down, not in the summary header.
    return {
      call: label,
      outcome: hasReasonText ? "revert-with-reason" : "network-error",
      detail: message,
    };
  }
}

async function main() {
  const rpcUrl = process.env["MONAD_TESTNET_RPC"];
  if (!rpcUrl) {
    console.error("MONAD_TESTNET_RPC is not set in .env, cannot run this probe.");
    process.exitCode = 1;
    return;
  }

  const client = createPublicClient({ transport: http(rpcUrl) });

  console.log(`SPIKE: reading IAPassComplianceValidator at ${VALIDATOR_ADDRESS} on Monad testnet`);
  console.log(`RPC: ${rpcUrl.replace(/\/[^/]*$/, "/<redacted>")}`); // never print a full RPC URL, some providers embed an API key in the path
  console.log("");

  const chainId = await client.getChainId().catch((err) => {
    console.log(`getChainId() failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  });
  console.log(`chainId: ${chainId ?? "UNKNOWN (RPC call failed)"}`);

  const bytecode = await client.getCode({ address: VALIDATOR_ADDRESS }).catch((err) => {
    console.log(`getCode() failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  });
  console.log(`getCode(${VALIDATOR_ADDRESS}): ${bytecode ? `${bytecode.length} chars of bytecode present` : "EMPTY (no contract deployed at this address on this chain)"}`);
  console.log("");

  const results: ProbeOutcome[] = [];

  results.push(
    await readOne(client, `isRegistered(${ZERO_ADDRESS})`, () =>
      client.readContract({ address: VALIDATOR_ADDRESS, abi: VALIDATOR_READ_ABI, functionName: "isRegistered", args: [ZERO_ADDRESS] }),
    ),
  );
  results.push(
    await readOne(client, `isRegistered(${CANDIDATE_POOL_ADDR})`, () =>
      client.readContract({ address: VALIDATOR_ADDRESS, abi: VALIDATOR_READ_ABI, functionName: "isRegistered", args: [CANDIDATE_POOL_ADDR] }),
    ),
  );
  results.push(
    await readOne(client, `complianceVerify(${ZERO_ADDRESS}, ${ZERO_ADDRESS})`, () =>
      client.readContract({
        address: VALIDATOR_ADDRESS,
        abi: VALIDATOR_READ_ABI,
        functionName: "complianceVerify",
        args: [ZERO_ADDRESS, ZERO_ADDRESS],
      }),
    ),
  );
  results.push(
    await readOne(client, `complianceVerify(${CANDIDATE_POOL_ADDR}, ${ZERO_ADDRESS})`, () =>
      client.readContract({
        address: VALIDATOR_ADDRESS,
        abi: VALIDATOR_READ_ABI,
        functionName: "complianceVerify",
        args: [CANDIDATE_POOL_ADDR, ZERO_ADDRESS],
      }),
    ),
  );

  console.log("Results:");
  for (const r of results) {
    console.log(`  ${r.call}`);
    console.log(`    outcome: ${r.outcome}`);
    console.log(`    detail:  ${r.detail}`);
  }
}

main().catch((err) => {
  console.error("spike-validator-read failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
