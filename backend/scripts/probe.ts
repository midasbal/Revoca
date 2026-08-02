/**
 * Live, read-only probe against the Cleanverse UAT sandbox.
 *
 * Only calls endpoints documented as plain-JSON reads (query_apass_list,
 * validator/verify, validator/is_register, atoken/list_my_atokens). Does
 * NOT call faucet, its request/response fields aren't fully specified in
 * the PDF (see docs/CLEANVERSE_API.md), and it may dispense funds and
 * consume a rate-limited allowance, so it's not something to call
 * speculatively. That's logged as a deliberate skip below, not silently
 * dropped.
 *
 * Run with: npm run probe
 *
 * Never logs CLEANVERSE_API_KEY or the full CLEANVERSE_API_ID, only a
 * redacted (first-4-chars) form, via config.ts's redact().
 */
import { loadConfig, redact } from "../src/cleanverse/config.js";
import { CleanverseClient } from "../src/cleanverse/client.js";
import { CleanverseApiError, CleanverseTransportError } from "../src/cleanverse/errors.js";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000".slice(0, 42);

/**
 * A real pool address surfaced by query_apass_list's own response
 * (customerId "CCPOOLV20001MONAD", "CCP" matches our Validator
 * Compliance/CCP mapping). Used as a second validator/verify + is_register
 * probe against a plausibly-registered address, since a first pass against
 * ZERO_ADDR can't distinguish "no permission to call this endpoint" from
 * "this specific pool was never registered on-chain", both surface as
 * code 12027 (on-chain read failed).
 */
const CANDIDATE_POOL_ADDR = "0xEA459EB91F7Dc1fF866282C1E80b9fdE7C4b297d";

interface ProbeResult {
  endpoint: string;
  outcome: "success" | "api-error" | "transport-error" | "network-error" | "skipped";
  detail: string;
  raw?: unknown;
}

async function probe(endpoint: string, fn: () => Promise<unknown>): Promise<ProbeResult> {
  try {
    const data = await fn();
    return { endpoint, outcome: "success", detail: "code 0000, endpoint accessible", raw: data };
  } catch (err) {
    if (err instanceof CleanverseApiError) {
      return {
        endpoint,
        outcome: "api-error",
        detail: `code ${err.code}: ${err.apiMessage}`,
      };
    }
    if (err instanceof CleanverseTransportError) {
      return {
        endpoint,
        outcome: "transport-error",
        detail: `HTTP ${err.status} ${err.statusText}`,
      };
    }
    return {
      endpoint,
      outcome: "network-error",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main() {
  const config = loadConfig();
  console.log(`Using api-id: ${redact(config.apiId)} against ${config.sandboxUrl}`);
  console.log("(api-key is never printed)\n");

  const client = new CleanverseClient(config);
  const results: ProbeResult[] = [];

  results.push(
    await probe("query_apass_list", () => client.queryApassList({ page: 1, pageSize: 20, chain: "monad" })),
  );

  results.push(
    await probe("validator/verify", () =>
      client.validatorVerify({ chain: "monad", contract_address: ZERO_ADDR, user_address: ZERO_ADDR }),
    ),
  );

  results.push(
    await probe("validator/is_register", () =>
      client.validatorIsRegister({ chain: "monad", contract_address: ZERO_ADDR }),
    ),
  );

  results.push(await probe("atoken/list_my_atokens", () => client.listAtokens({ chain: "monad" })));

  results.push(
    await probe("validator/verify (candidate registered pool)", () =>
      client.validatorVerify({ chain: "monad", contract_address: CANDIDATE_POOL_ADDR, user_address: ZERO_ADDR }),
    ),
  );

  results.push(
    await probe("validator/is_register (candidate registered pool)", () =>
      client.validatorIsRegister({ chain: "monad", contract_address: CANDIDATE_POOL_ADDR }),
    ),
  );

  results.push({
    endpoint: "faucet",
    outcome: "skipped",
    detail:
      "Not called: PDF doesn't fully specify faucet's request fields, and calling it may dispense " +
      "real (testnet) funds and consume a rate-limited allowance, see docs/CLEANVERSE_API.md and " +
      "docs/OPEN_QUESTIONS.md. Confirm exact fields against the PDF directly before calling live.",
  });

  console.log("=== Probe results ===\n");
  for (const r of results) {
    console.log(`--- ${r.endpoint} ---`);
    console.log(`outcome: ${r.outcome}`);
    console.log(`detail:  ${r.detail}`);
    if (r.raw !== undefined) {
      console.log(`data:    ${JSON.stringify(r.raw, null, 2)}`);
    }
    console.log("");
  }

  const accessible = results.filter((r) => r.outcome === "success").length;
  const denied = results.filter((r) => r.outcome === "api-error").length;
  const made = results.filter((r) => r.outcome !== "skipped").length;
  console.log(`Summary: ${accessible} accessible, ${denied} api-error, out of ${made} calls made (faucet skipped).`);
}

main().catch((err) => {
  console.error("Probe failed to run:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
