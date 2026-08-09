/**
 * Minimal, dependency-free HTTP helpers shared by every serverless
 * function in this directory. Deliberately typed against plain Node
 * request/response shapes (not `@vercel/node`'s types) so these functions
 * run unmodified on Vercel's Node runtime today and on any other
 * Node-based serverless host later, see docs/ARCHITECTURE.md's
 * frontend/backend split: "small, stateless, serverless-friendly
 * functions", not a Vercel-specific implementation.
 *
 * Vercel's Node runtime auto-parses a JSON request body into `req.body`
 * before the handler runs; `readJsonBody` uses that when present and
 * falls back to reading the raw stream itself otherwise (local testing,
 * or any host that doesn't pre-parse), so the same handler code works in
 * both places.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export interface MinimalRequest extends IncomingMessage {
  method?: string;
  body?: unknown;
}

export type MinimalResponse = ServerResponse;

/** Every response, success or error, carries this so the frontend (a different origin from the deployed backend) can call it directly. */
export function withCors(res: MinimalResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

/** Handles the CORS preflight; returns true if the caller should stop (request was OPTIONS and is now fully handled). */
export function handlePreflight(req: MinimalRequest, res: MinimalResponse): boolean {
  withCors(res);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return true;
  }
  return false;
}

export async function readJsonBody<T>(req: MinimalRequest): Promise<T> {
  if (req.body !== undefined) {
    return (typeof req.body === "string" ? JSON.parse(req.body) : req.body) as T;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as T) : ({} as T);
}

export function sendJson(res: MinimalResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

/** Best-effort caller IP, used only for the in-memory rate limiter (see src/onboarding/rateLimit.ts), never trusted for anything security-critical on its own. Most serverless hosts (Vercel included) set x-forwarded-for themselves, so it isn't attacker-spoofable in that deployment even though the header is nominally client-controlled. */
export function clientIp(req: MinimalRequest): string {
  const forwarded = req.headers["x-forwarded-for"];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (first) return first.split(",")[0]!.trim();
  return req.socket?.remoteAddress ?? "unknown";
}
