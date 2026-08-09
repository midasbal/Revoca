import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/onboarding/fund.js", () => ({
  fundGasOnly: vi.fn(async (address: string) => ({ address, funded: true, gasTxHash: "0xabc" })),
}));

import handler from "../api/onboarding/fund-gas.js";

/** Minimal fake IncomingMessage/ServerResponse pair, just enough for the handler under test. */
function fakeReqRes(body: unknown, ip: string) {
  const req = new EventEmitter() as unknown as {
    method: string;
    headers: Record<string, string>;
    body: unknown;
    socket: { remoteAddress: string };
  };
  req.method = "POST";
  req.headers = { "x-forwarded-for": ip };
  req.body = body;
  req.socket = { remoteAddress: ip };

  let statusCode = 0;
  let payload = "";
  const res = {
    setHeader: () => {},
    get statusCode() {
      return statusCode;
    },
    set statusCode(v: number) {
      statusCode = v;
    },
    end: (data?: string) => {
      payload = data ?? "";
    },
  };

  return { req, res, getStatus: () => statusCode, getBody: () => (payload ? JSON.parse(payload) : null) };
}

describe("fund-gas rate limiting (integration)", () => {
  it("allows the first request per address, then 429s a repeat within the cooldown", async () => {
    const address = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
    const first = fakeReqRes({ address }, "203.0.113.1");
    await handler(first.req as never, first.res as never);
    expect(first.getStatus()).toBe(200);
    expect(first.getBody()).toMatchObject({ funded: true });

    const second = fakeReqRes({ address }, "203.0.113.1");
    await handler(second.req as never, second.res as never);
    expect(second.getStatus()).toBe(429);
    expect(second.getBody().error).toMatch(/rate limit/i);
  });

  it("does not rate-limit a different address from the same IP", async () => {
    const ip = "203.0.113.2";
    const addrA = "0x6813Eb9362372EEF6200f3b1dbC3f819671cBA69";
    const addrB = "0x1efF47bc3a10a45D4B230B5d10E37751FE6AA718";

    const a = fakeReqRes({ address: addrA }, ip);
    await handler(a.req as never, a.res as never);
    expect(a.getStatus()).toBe(200);

    const b = fakeReqRes({ address: addrB }, ip);
    await handler(b.req as never, b.res as never);
    expect(b.getStatus()).toBe(200);
  });
});
