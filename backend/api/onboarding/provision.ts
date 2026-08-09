/**
 * POST /api/onboarding/provision, deploy target: Vercel serverless
 * function (Node runtime). Real, synchronous: this handler does not
 * return until the whole onboarding sequence (generate_apass, verify,
 * on-chain attestation, gas + rtUSD funding) has actually completed or
 * failed, no "started, poll elsewhere" placeholder, see
 * frontend/src/api/backendContract.ts for the shared request/response
 * shape.
 */
import { isAddress } from "viem";
import { clientIp, handlePreflight, readJsonBody, sendJson, type MinimalRequest, type MinimalResponse } from "../_http.js";
import { parseOnboardingSubTier, provisionBorrower, ProvisionError } from "../../src/onboarding/provision.js";
import { enforceRateLimit, RateLimitExceededError } from "../../src/onboarding/rateLimit.js";

const ADDRESS_LIMIT = { max: 1, windowMs: 5 * 60_000 }; // one provision attempt per address per 5 minutes
const IP_LIMIT = { max: 5, windowMs: 10 * 60_000 }; // five provision attempts per caller IP per 10 minutes

export const config = { maxDuration: 60 };

interface ProvisionRequestBody {
  address?: string;
  subTier?: string;
}

export default async function handler(req: MinimalRequest, res: MinimalResponse): Promise<void> {
  if (handlePreflight(req, res)) return;

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed, use POST." });
    return;
  }

  let body: ProvisionRequestBody;
  try {
    body = await readJsonBody<ProvisionRequestBody>(req);
  } catch {
    sendJson(res, 400, { error: "Request body must be valid JSON." });
    return;
  }

  if (!body.address || !isAddress(body.address)) {
    sendJson(res, 400, { error: "A valid `address` is required." });
    return;
  }

  let subTier: ReturnType<typeof parseOnboardingSubTier>;
  try {
    subTier = parseOnboardingSubTier(body.subTier);
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    return;
  }

  try {
    enforceRateLimit(`provision:addr:${body.address.toLowerCase()}`, ADDRESS_LIMIT.max, ADDRESS_LIMIT.windowMs);
    enforceRateLimit(`provision:ip:${clientIp(req)}`, IP_LIMIT.max, IP_LIMIT.windowMs);
  } catch (err) {
    if (err instanceof RateLimitExceededError) {
      sendJson(res, 429, { error: err.message });
      return;
    }
    throw err;
  }

  try {
    const result = await provisionBorrower(body.address, subTier);
    sendJson(res, 200, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const step = err instanceof ProvisionError ? err.step : "unknown";
    sendJson(res, 502, { error: message, step });
  }
}
