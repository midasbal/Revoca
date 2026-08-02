/**
 * Wraps CleanverseClient into an ApassDataSource, the live, real-sandbox
 * path. Always calls `query_apass` SINGULAR (authoritative per-address
 * lookup), never `query_apass_list`. No mock data.
 */
import { CleanverseClient } from "../cleanverse/client.js";
import type { ApassDataSource } from "./classify.js";

export function cleanverseDataSource(client: CleanverseClient, chain: string): ApassDataSource {
  return async (address: string) => {
    const data = await client.queryApass({ chain, address });
    return {
      status: data.status,
      expirationTime: data.expirationTime,
      tier: data.tier,
      subTier: data.subTier,
    };
  };
}
