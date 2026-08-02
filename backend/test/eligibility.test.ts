import { describe, expect, it } from "vitest";
import { determineEligibility, EligibilityReason } from "../src/keeper/eligibility.js";

const NOW = 1_800_000_000;

describe("determineEligibility", () => {
  it("classifies status:2 as FROZEN regardless of other fields", () => {
    const result = determineEligibility({
      status: 2,
      expirationTime: NOW + 1000,
      tier: 50,
      subTier: 80,
      nowUnixSeconds: NOW,
      poolMinTier: 20,
    });
    expect(result).toEqual({ compliant: false, reason: EligibilityReason.FROZEN });
  });

  it("classifies null status as INELIGIBLE (fail closed, not treated as active)", () => {
    const result = determineEligibility({
      status: null,
      expirationTime: null,
      tier: 50,
      subTier: 80,
      nowUnixSeconds: NOW,
      poolMinTier: 20,
    });
    expect(result).toEqual({ compliant: false, reason: EligibilityReason.INELIGIBLE });
  });

  it("classifies an unexpected status value as INELIGIBLE", () => {
    const result = determineEligibility({
      status: 99,
      expirationTime: null,
      tier: 50,
      subTier: 80,
      nowUnixSeconds: NOW,
      poolMinTier: 20,
    });
    expect(result).toEqual({ compliant: false, reason: EligibilityReason.INELIGIBLE });
  });

  it("classifies status:1 with a past expirationTime as EXPIRED", () => {
    const result = determineEligibility({
      status: 1,
      expirationTime: NOW - 1,
      tier: 50,
      subTier: 80,
      nowUnixSeconds: NOW,
      poolMinTier: 20,
    });
    expect(result).toEqual({ compliant: false, reason: EligibilityReason.EXPIRED });
  });

  it("treats expirationTime exactly equal to now as EXPIRED (boundary)", () => {
    const result = determineEligibility({
      status: 1,
      expirationTime: NOW,
      tier: 50,
      subTier: 80,
      nowUnixSeconds: NOW,
      poolMinTier: 20,
    });
    expect(result.compliant).toBe(false);
    expect(result.reason).toBe(EligibilityReason.EXPIRED);
  });

  it("treats null expirationTime as no expiration", () => {
    const result = determineEligibility({
      status: 1,
      expirationTime: null,
      tier: 50,
      subTier: 80,
      nowUnixSeconds: NOW,
      poolMinTier: 20,
    });
    expect(result.compliant).toBe(true);
  });

  it("classifies status:1, not expired, but tier below pool minimum as INELIGIBLE", () => {
    const result = determineEligibility({
      status: 1,
      expirationTime: NOW + 1000,
      tier: 10,
      subTier: 0,
      nowUnixSeconds: NOW,
      poolMinTier: 20,
    });
    expect(result).toEqual({ compliant: false, reason: EligibilityReason.INELIGIBLE });
  });

  it("classifies null tier as INELIGIBLE even if status is active", () => {
    const result = determineEligibility({
      status: 1,
      expirationTime: NOW + 1000,
      tier: null,
      subTier: null,
      nowUnixSeconds: NOW,
      poolMinTier: 20,
    });
    expect(result).toEqual({ compliant: false, reason: EligibilityReason.INELIGIBLE });
  });

  it("classifies as compliant when status active, not expired, and tier meets the minimum exactly", () => {
    const result = determineEligibility({
      status: 1,
      expirationTime: NOW + 1000,
      tier: 20,
      subTier: 0,
      nowUnixSeconds: NOW,
      poolMinTier: 20,
    });
    expect(result).toEqual({ compliant: true, reason: EligibilityReason.NONE });
  });

  it("classifies as compliant when tier exceeds the minimum", () => {
    const result = determineEligibility({
      status: 1,
      expirationTime: NOW + 1000,
      tier: 50,
      subTier: 80,
      nowUnixSeconds: NOW,
      poolMinTier: 20,
    });
    expect(result).toEqual({ compliant: true, reason: EligibilityReason.NONE });
  });

  it("never returns BLACKLISTED or TIER_DROP, those are not derivable from query_apass alone", () => {
    // Sweep a range of inputs and confirm neither reason ever appears,
    // documents, in a test, exactly what this function is capable of
    // distinguishing (see this module's header).
    const statuses = [1, 2, null, undefined, 0, 3];
    const tiers = [null, 0, 10, 20, 50];
    for (const status of statuses) {
      for (const tier of tiers) {
        const result = determineEligibility({
          status,
          expirationTime: null,
          tier,
          subTier: 0,
          nowUnixSeconds: NOW,
          poolMinTier: 20,
        });
        expect(result.reason).not.toBe(EligibilityReason.BLACKLISTED);
        expect(result.reason).not.toBe(EligibilityReason.TIER_DROP);
      }
    }
  });
});
