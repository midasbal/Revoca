import { describe, expect, it } from "vitest";
import { enforceRateLimit, RateLimitExceededError } from "../src/onboarding/rateLimit.js";

describe("enforceRateLimit", () => {
  it("allows calls up to the limit, then throws", () => {
    const key = `test:${Math.random()}`;
    enforceRateLimit(key, 2, 60_000);
    enforceRateLimit(key, 2, 60_000);
    expect(() => enforceRateLimit(key, 2, 60_000)).toThrow(RateLimitExceededError);
  });

  it("tracks distinct keys independently", () => {
    const a = `test:${Math.random()}`;
    const b = `test:${Math.random()}`;
    enforceRateLimit(a, 1, 60_000);
    expect(() => enforceRateLimit(a, 1, 60_000)).toThrow(RateLimitExceededError);
    expect(() => enforceRateLimit(b, 1, 60_000)).not.toThrow();
  });

  it("resets after the window elapses", () => {
    const key = `test:${Math.random()}`;
    enforceRateLimit(key, 1, 10);
    expect(() => enforceRateLimit(key, 1, 10)).toThrow(RateLimitExceededError);
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(() => enforceRateLimit(key, 1, 10)).not.toThrow();
        resolve();
      }, 20);
    });
  });

  it("throws a message that names an honest retry time", () => {
    const key = `test:${Math.random()}`;
    enforceRateLimit(key, 1, 60_000);
    try {
      enforceRateLimit(key, 1, 60_000);
      throw new Error("expected enforceRateLimit to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitExceededError);
      expect((err as Error).message).toMatch(/try again in about \d+s/i);
    }
  });
});
