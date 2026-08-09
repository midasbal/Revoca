/**
 * POST /api/onboarding/fund, deploy target: Vercel serverless function.
 * Real rtUSD top-up (+ gas if the address is running low) for an address
 * that already has standing, see backend/src/onboarding/fund.ts.
 */
import { isAddress } from "viem";
import { handlePreflight, readJsonBody, sendJson, type MinimalRequest, type MinimalResponse } from "../_http.js";
import { fundBorrower } from "../../src/onboarding/fund.js";

export const config = { maxDuration: 30 };

interface FundRequestBody {
  address?: string;
  /** Raw 18-decimal amount, as a decimal string, never a JS number (precision), matching frontend/src/api/backendContract.ts. */
  amount?: string;
}

const DEFAULT_AMOUNT = 2_000n * 10n ** 18n;

export default async function handler(req: MinimalRequest, res: MinimalResponse): Promise<void> {
  if (handlePreflight(req, res)) return;

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed, use POST." });
    return;
  }

  let body: FundRequestBody;
  try {
    body = await readJsonBody<FundRequestBody>(req);
  } catch {
    sendJson(res, 400, { error: "Request body must be valid JSON." });
    return;
  }

  if (!body.address || !isAddress(body.address)) {
    sendJson(res, 400, { error: "A valid `address` is required." });
    return;
  }

  let amount = DEFAULT_AMOUNT;
  if (body.amount !== undefined) {
    try {
      amount = BigInt(body.amount);
    } catch {
      sendJson(res, 400, { error: "`amount` must be a raw 18-decimal integer string." });
      return;
    }
  }

  try {
    const result = await fundBorrower(body.address, amount);
    sendJson(res, 200, result);
  } catch (err) {
    sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
  }
}
