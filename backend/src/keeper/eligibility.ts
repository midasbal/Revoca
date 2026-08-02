/**
 * Pure eligibility-determination logic for the RevocationGuardian keeper.
 *
 * Deliberately separated from any network call: this module takes the
 * already-fetched fields from a `query_apass` (SINGULAR) response, per
 * docs/OPEN_QUESTIONS.md item 7, the singular endpoint is authoritative for
 * a specific borrower's tier/subTier/expirationTime where `query_apass_list`
 * can serve stale/partial data, and decides compliant/reason without
 * touching the network itself, so it's fully unit-testable without hitting
 * the sandbox.
 *
 * Reason values mirror contracts/src/ComplianceRegistry.sol's `Reason` enum
 * ordinals EXACTLY (NONE=0, FROZEN=1, EXPIRED=2, BLACKLISTED=3,
 * INELIGIBLE=4, TIER_DROP=5), the keeper writes this numeric value
 * directly into `observeCompliance`'s `reason` parameter. TIER_DROP (5) is
 * never returned here: it's pool-relative (a specific position's debt vs.
 * its collateral at the current tier-derived ratio), which only
 * RevocationGuardian can determine, since this module has no visibility
 * into any pool's positions. BLACKLISTED (3) is defined for
 * forward-compatibility but never returned either, `query_apass`'s
 * response has no field indicating blacklist status (see
 * docs/OPEN_QUESTIONS.md item 5); if Cleanverse exposes that later, wire it
 * in here, not by guessing at a field that doesn't exist today.
 */

export enum EligibilityReason {
  NONE = 0,
  FROZEN = 1,
  EXPIRED = 2,
  BLACKLISTED = 3,
  INELIGIBLE = 4,
  TIER_DROP = 5,
}

export interface EligibilityInput {
  /** `query_apass`'s `status` field: 1 = active, 2 = frozen. Anything else (including null/undefined) is treated as unknown, not active. */
  status: number | null | undefined;
  /** `query_apass`'s `expirationTime`, unix seconds. `null`/`undefined` means no expiration. */
  expirationTime: number | null | undefined;
  /** Parsed numeric tier (see backend/src/risk/tierRatios.ts's parseApiTier for the string->number boundary). `null` means unknown/missing. */
  tier: number | null;
  subTier: number | null;
  /** Current time, unix seconds, passed in explicitly rather than read internally, so this function stays pure/deterministic for tests. */
  nowUnixSeconds: number;
  /**
   * This pool's absolute minimum tier for participation at all, distinct
   * from tier-derived COLLATERAL RATIO scaling (backend/src/risk/tierRatios.ts),
   * which applies continuously above this floor. Mirrors the same concept
   * as a Cleanverse Validator Rule's `min_tier` field, but enforced here by
   * the keeper rather than on-chain, since the registry only stores a
   * single compliant boolean, this floor is baked into that boolean
   * before it's ever written on-chain.
   */
  poolMinTier: number;
}

export interface EligibilityResult {
  compliant: boolean;
  reason: EligibilityReason;
}

export function determineEligibility(input: EligibilityInput): EligibilityResult {
  if (input.status === 2) {
    return { compliant: false, reason: EligibilityReason.FROZEN };
  }

  if (input.status !== 1) {
    // Covers null/undefined/any other unexpected value, fail closed,
    // don't treat "unknown" as "active" (see docs/TIER_DISTRIBUTION.md's
    // status-null observation and docs/OPEN_QUESTIONS.md item 3).
    return { compliant: false, reason: EligibilityReason.INELIGIBLE };
  }

  if (input.expirationTime !== null && input.expirationTime !== undefined && input.expirationTime <= input.nowUnixSeconds) {
    return { compliant: false, reason: EligibilityReason.EXPIRED };
  }

  if (input.tier === null || input.tier < input.poolMinTier) {
    return { compliant: false, reason: EligibilityReason.INELIGIBLE };
  }

  return { compliant: true, reason: EligibilityReason.NONE };
}
