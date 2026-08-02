/**
 * Classifies a single borrower's current eligibility from a raw A-Pass
 * field source. Source-agnostic by design: the SANDBOX path
 * (`cleanverseDataSource`) always calls `query_apass` SINGULAR against the
 * live Cleanverse sandbox, never `query_apass_list`, per
 * docs/OPEN_QUESTIONS.md item 7's finding that the list endpoint can serve
 * stale/partial tier and expiration data relative to the singular
 * per-address lookup, and never mock data. The LOCAL REHEARSAL path
 * (`attestor/attest.ts`'s `LocalApassFactSimulator`) feeds the exact same
 * shape from an in-process simulator instead, so the end-to-end rehearsal
 * can deterministically flip a borrower frozen/unfrozen without touching
 * the network at all. `determineEligibility` (eligibility.ts), the actual
 * decision logic, is identical either way; only where the raw fields come
 * from differs.
 */
import { parseApiTier } from "../risk/tierRatios.js";
import { determineEligibility, type EligibilityReason } from "./eligibility.js";

/** Raw A-Pass fields, in query_apass's own shape (tier as a string). */
export interface RawApassFields {
  status: number | null | undefined;
  expirationTime: number | null | undefined;
  tier: string | null | undefined;
  subTier: number | null | undefined;
}

/** Fetches the raw A-Pass fields for one address, from wherever this source gets its data. */
export type ApassDataSource = (address: string) => Promise<RawApassFields>;

export interface BorrowerClassification {
  address: string;
  compliant: boolean;
  reason: EligibilityReason;
  tier: number | null;
  subTier: number | null;
  status: number | null;
  expirationTime: number | null;
}

/**
 * Pure decision step, split out from `classifyBorrower` so callers that
 * already have the raw fields in hand (e.g. poller.ts, which also needs
 * them to build an EIP-712 attestation via backend/src/attestor) don't
 * have to fetch them twice from the same source.
 */
export function classifyFromRawFields(
  data: RawApassFields,
  address: string,
  poolMinTier: number,
  nowUnixSeconds: number,
): BorrowerClassification {
  const tier = parseApiTier(data.tier ?? null);
  const subTier = data.subTier ?? null;
  const status = data.status ?? null;
  const expirationTime = data.expirationTime ?? null;

  const { compliant, reason } = determineEligibility({
    status,
    expirationTime,
    tier,
    subTier,
    nowUnixSeconds,
    poolMinTier,
  });

  return { address, compliant, reason, tier, subTier, status, expirationTime };
}

export async function classifyBorrower(
  source: ApassDataSource,
  address: string,
  poolMinTier: number,
  nowUnixSeconds: number,
): Promise<BorrowerClassification> {
  const data = await source(address);
  return classifyFromRawFields(data, address, poolMinTier, nowUnixSeconds);
}
