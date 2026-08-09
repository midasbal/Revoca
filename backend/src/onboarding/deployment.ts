/**
 * Current Revoca deployment on Monad testnet, the backend's own copy.
 * Deliberately mirrors frontend/src/deployment.ts's addresses (both read
 * from the same deployments/testnet.json after a redeploy), kept separate
 * rather than imported cross-package since backend/ and frontend/ are
 * independent deployable units with no shared build step, see
 * docs/ARCHITECTURE.md's frontend/backend split.
 */
import type { Address } from "viem";

export const CHAIN_ID = 10143;

export const DEPLOYMENT = {
  asset: "0x6d9756dbd3a8429f47da4adf0241c7cdcda88316" as Address,
  policy: "0x9bed52366d8b30b5e6a876a4ec4a779ed15eaf6f" as Address,
  registry: "0x54dfddf156198b6e5107886ec43ebf9ed6acfb14" as Address,
  gate: "0x7a066511ce2e205b716df55bc5f8f03b74bca611" as Address,
  pool: "0x43446f24a860c9c13d138483275b879e16d614dd" as Address,
  guardian: "0xd3203e056ce71884a9a49fb73d7ec32349ff9a8b" as Address,
} as const;
