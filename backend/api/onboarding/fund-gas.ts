/**
 * POST /api/onboarding/fund-gas, deploy target: Vercel serverless
 * function. Gas only, no rtUSD mint, for ANY connected wallet, not just
 * one that already went through borrower onboarding, see
 * backend/src/onboarding/fund.ts's fundGasOnly. The general fix for a
 * wallet that has 0 MON and therefore cannot send any transaction at
 * all, most directly a lender, who has no onboarding step to fund it.
 */
import { isAddress } from "viem";
import { handlePreflight, readJsonBody, sendJson, type MinimalRequest, type MinimalResponse } from "../_http.js";
import { fundGasOnly } from "../../src/onboarding/fund.js";

export const config = { maxDuration: 30 };

interface FundGasRequestBody {
  address?: string;
}

export default async function handler(req: MinimalRequest, res: MinimalResponse): Promise<void> {
  if (handlePreflight(req, res)) return;

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed, use POST." });
    return;
  }

  let body: FundGasRequestBody;
  try {
    body = await readJsonBody<FundGasRequestBody>(req);
  } catch {
    sendJson(res, 400, { error: "Request body must be valid JSON." });
    return;
  }

  if (!body.address || !isAddress(body.address)) {
    sendJson(res, 400, { error: "A valid `address` is required." });
    return;
  }

  try {
    const result = await fundGasOnly(body.address);
    sendJson(res, 200, result);
  } catch (err) {
    sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
  }
}
