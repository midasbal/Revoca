/**
 * Typed error classes for the Cleanverse client. Kept distinct per
 * docs/CLEANVERSE_API.md's response envelope, a non-2xx HTTP status and a
 * `code !== "0000"` business failure are different failure modes and should
 * never be conflated into one generic "request failed" error.
 */

/** Non-2xx HTTP response, the request didn't reach Cleanverse's business logic. */
export class CleanverseTransportError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly requestId: string,
    bodyText?: string,
  ) {
    super(
      `Cleanverse transport error: HTTP ${status} ${statusText} (request-id: ${requestId})` +
        (bodyText ? `, ${truncate(bodyText, 500)}` : ""),
    );
    this.name = "CleanverseTransportError";
  }
}

/**
 * HTTP 200, but the response envelope's `code` is not "0000", a genuine
 * business-logic failure (bad params, permission denied, on-chain write
 * failure, etc). Not to be confused with a legitimate negative result like
 * `validator/verify` returning `valid: false` under code "0000", which is
 * not an error at all and is returned normally by the client.
 */
export class CleanverseApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly apiMessage: string,
    public readonly requestId: string,
  ) {
    super(`Cleanverse API error ${code}: ${apiMessage} (request-id: ${requestId})`);
    this.name = "CleanverseApiError";
  }
}

/** The response body wasn't valid JSON, or was missing an expected field (code/message/data). */
export class CleanverseResponseShapeError extends Error {
  constructor(
    public readonly requestId: string,
    detail: string,
  ) {
    super(`Cleanverse response shape error (request-id: ${requestId}): ${detail}`);
    this.name = "CleanverseResponseShapeError";
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
