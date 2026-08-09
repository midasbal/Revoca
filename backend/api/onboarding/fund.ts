/**
 * POST /api/onboarding/fund, deploy target: Vercel serverless function.
 * Real rtUSD top-up (+ gas if the address is running low) for an address
 * that already has standing, see backend/src/onboarding/fund.ts.
 */
import { isAddress } from "viem";
import { clientIp, handlePreflight, readJsonBody, sendJson, type MinimalRequest, type MinimalResponse } from "../_http.js";
import { fundBorrower, InvalidFundAmountError } from "../../src/onboarding/fund.js";
import { enforceRateLimit, RateLimitExceededError } from "../../src/onboarding/rateLimit.js";

const ADDRESS_LIMIT = { max: 1, windowMs: 2 * 60_000 }; // one fund attempt per address per 2 minutes
const IP_LIMIT = { max: 5, windowMs: 10 * 60_000 }; // five fund attempts per caller IP per 10 minutes

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
    enforceRateLimit(`fund:addr:${body.address.toLowerCase()}`, ADDRESS_LIMIT.max, ADDRESS_LIMIT.windowMs);
    enforceRateLimit(`fund:ip:${clientIp(req)}`, IP_LIMIT.max, IP_LIMIT.windowMs);
  } catch (err) {
    if (err instanceof RateLimitExceededError) {
      sendJson(res, 429, { error: err.message });
      return;
    }
    throw err;
  }

  try {
    const result = await fundBorrower(body.address, amount);
    sendJson(res, 200, result);
  } catch (err) {
    if (err instanceof InvalidFundAmountError) {
      sendJson(res, 400, { error: err.message });
      return;
    }
    sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
  }
}
