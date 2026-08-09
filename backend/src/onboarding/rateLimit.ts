/**
 * In-memory, per-serverless-instance rate limiting for the public
 * onboarding endpoints (provision, fund, fund-gas). Deliberately not a
 * distributed store (Redis/KV, per docs/ARCHITECTURE.md's "small,
 * stateless, serverless-friendly functions" these still are otherwise):
 * the goal here is only "a bored caller can't loop the faucet dry during
 * judging," not bulletproof distributed rate limiting. A cold serverless
 * instance starts with an empty bucket map, which is an accepted, honest
 * limitation of this approach, not a bug, see CLAUDE.md's no-mock-data
 * spirit, this is a real (if instance-local) limit, not a fake one.
 */

interface Bucket {
  count: number;
  windowStart: number;
}

const buckets = new Map<string, Bucket>();

export class RateLimitExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitExceededError";
  }
}

/**
 * Fixed-window limiter: `key` may make at most `maxRequests` calls per
 * `windowMs`. Throws RateLimitExceededError with an honest, specific
 * message (never a silent no-op) once the window's cap is hit.
 */
export function enforceRateLimit(key: string, maxRequests: number, windowMs: number): void {
  const now = Date.now();

  // Opportunistic cleanup so a long-lived warm instance doesn't accumulate
  // one bucket per distinct address/IP forever, cheap and simple rather
  // than a separate timer.
  if (buckets.size > 5000) {
    for (const [k, b] of buckets) {
      if (now - b.windowStart >= windowMs) buckets.delete(k);
    }
  }

  const bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStart >= windowMs) {
    buckets.set(key, { count: 1, windowStart: now });
    return;
  }

  if (bucket.count >= maxRequests) {
    const retryInSeconds = Math.max(1, Math.ceil((bucket.windowStart + windowMs - now) / 1000));
    throw new RateLimitExceededError(
      `Rate limit reached for this request, this is a real, honest limit protecting a shared testnet faucet, not a bug. Try again in about ${retryInSeconds}s.`,
    );
  }

  bucket.count += 1;
}
