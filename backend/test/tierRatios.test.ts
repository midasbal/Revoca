import { describe, expect, it } from "vitest";
import { BPS_DENOMINATOR, SAFEST_RATIO_BPS, collateralRatioBps, parseApiTier } from "../src/risk/tierRatios.js";

describe("collateralRatioBps, fallback behavior", () => {
  it("falls back to the safest ratio for null tier", () => {
    expect(collateralRatioBps(null, 80)).toBe(SAFEST_RATIO_BPS);
  });

  it("falls back to the safest ratio for undefined tier", () => {
    expect(collateralRatioBps(undefined, 50)).toBe(SAFEST_RATIO_BPS);
  });

  it("falls back to the safest ratio for negative tier", () => {
    expect(collateralRatioBps(-1, 80)).toBe(SAFEST_RATIO_BPS);
  });

  it("falls back to the safest ratio for non-finite tier", () => {
    expect(collateralRatioBps(NaN, 80)).toBe(SAFEST_RATIO_BPS);
    expect(collateralRatioBps(Infinity, 80)).toBe(SAFEST_RATIO_BPS);
  });

  it("treats missing/invalid subTier as 0, not as a fallback to the safest ratio", () => {
    // tier 50 with unknown subTier should get tier 50's subTier-0 band, not SAFEST_RATIO_BPS.
    const withNullSubTier = collateralRatioBps(50, null);
    const withZeroSubTier = collateralRatioBps(50, 0);
    expect(withNullSubTier).toBe(withZeroSubTier);
    expect(withNullSubTier).toBeLessThan(SAFEST_RATIO_BPS);
  });
});

describe("collateralRatioBps, real observed tiers (docs/TIER_DISTRIBUTION.md)", () => {
  it("tier 0 (lowest real tier) gets the safest ratio, at or above 100%", () => {
    const ratio = collateralRatioBps(0, 0);
    expect(ratio).toBe(SAFEST_RATIO_BPS);
    expect(ratio).toBeGreaterThanOrEqual(BPS_DENOMINATOR);
  });

  it("tier 20 stays at or above 100% regardless of subTier", () => {
    for (const subTier of [0, 1, 9, 10, 20, 30, 50, 80]) {
      expect(collateralRatioBps(20, subTier)).toBeGreaterThanOrEqual(BPS_DENOMINATOR);
    }
  });

  it("tier 50 at subTier 0 is still over-collateralized (baseline, not yet earned the discount)", () => {
    expect(collateralRatioBps(50, 0)).toBeGreaterThanOrEqual(BPS_DENOMINATOR);
  });

  it("tier 50 at high subTier (80, a real 10.6% cohort) is under-collateralized", () => {
    expect(collateralRatioBps(50, 80)).toBeLessThan(BPS_DENOMINATOR);
  });

  it("no tier below 50 is ever under-collateralized, at any observed subTier", () => {
    for (const tier of [0, 20]) {
      for (const subTier of [0, 1, 9, 10, 20, 30, 50, 80]) {
        expect(collateralRatioBps(tier, subTier)).toBeGreaterThanOrEqual(BPS_DENOMINATOR);
      }
    }
  });
});

describe("collateralRatioBps, boundaries", () => {
  it("is exact at each band's minSubTier threshold, not just above it", () => {
    expect(collateralRatioBps(50, 80)).toBe(8_000);
    expect(collateralRatioBps(50, 79)).toBeGreaterThan(8_000); // just below the threshold -> worse ratio
    expect(collateralRatioBps(50, 50)).toBe(9_000);
    expect(collateralRatioBps(50, 49)).toBeGreaterThan(9_000);
    expect(collateralRatioBps(50, 20)).toBe(10_000);
    expect(collateralRatioBps(50, 19)).toBeGreaterThan(10_000);
  });

  it("a tier strictly between two observed tiers (e.g. 35) inherits the lower tier's band", () => {
    // No band exists for tier 35 specifically; it must fall through to the
    // highest minTier it still qualifies for (20), not jump ahead to 50's bands.
    expect(collateralRatioBps(35, 80)).toBe(collateralRatioBps(20, 80));
  });

  it("a tier above the highest observed tier (e.g. 99) still qualifies for tier 50's bands", () => {
    expect(collateralRatioBps(99, 80)).toBe(collateralRatioBps(50, 80));
  });
});

describe("collateralRatioBps, monotonicity", () => {
  it("higher tier never requires more collateral than a lower tier, holding subTier fixed", () => {
    const tiers = [0, 5, 20, 35, 50, 99];
    for (const subTier of [0, 20, 50, 80]) {
      let prevRatio = Infinity;
      for (const tier of tiers) {
        const ratio = collateralRatioBps(tier, subTier);
        expect(ratio).toBeLessThanOrEqual(prevRatio);
        prevRatio = ratio;
      }
    }
  });

  it("higher subTier never requires more collateral than a lower subTier, holding tier fixed", () => {
    const subTiers = [0, 1, 9, 10, 20, 30, 50, 80, 99];
    for (const tier of [0, 20, 50]) {
      let prevRatio = Infinity;
      for (const subTier of subTiers) {
        const ratio = collateralRatioBps(tier, subTier);
        expect(ratio).toBeLessThanOrEqual(prevRatio);
        prevRatio = ratio;
      }
    }
  });
});

describe("parseApiTier", () => {
  it("parses a numeric-looking string tier", () => {
    expect(parseApiTier("50")).toBe(50);
    expect(parseApiTier("0")).toBe(0);
  });

  it("returns null for missing/blank/non-numeric input", () => {
    expect(parseApiTier(null)).toBeNull();
    expect(parseApiTier(undefined)).toBeNull();
    expect(parseApiTier("")).toBeNull();
    expect(parseApiTier("   ")).toBeNull();
    expect(parseApiTier("not-a-tier")).toBeNull();
  });

  it("round-trips into collateralRatioBps' null-fallback behavior", () => {
    const tier = parseApiTier(undefined);
    expect(collateralRatioBps(tier, 80)).toBe(SAFEST_RATIO_BPS);
  });
});
