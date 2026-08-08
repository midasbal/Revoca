/**
 * Current Revoca deployment on Monad testnet. Addresses are public (the
 * whole point of an on-chain registry), never secrets, so this file is
 * tracked, unlike deployments/testnet.json at the repo root (gitignored,
 * since backend tooling regenerates it locally and it isn't meant to be
 * the source of truth for a deployed frontend build).
 *
 * PROVISIONAL, see docs/ROADMAP.md's refinement backlog: this pool will
 * be redeployed again as the contracts keep evolving. Update this file's
 * addresses (from deployments/testnet.json after a redeploy) when that
 * happens, this is the one place the frontend reads them from.
 */
export const CHAIN_ID = 10143;

export const DEPLOYMENT = {
  asset: '0x6d9756dbd3a8429f47da4adf0241c7cdcda88316',
  policy: '0x9bed52366d8b30b5e6a876a4ec4a779ed15eaf6f',
  registry: '0x54dfddf156198b6e5107886ec43ebf9ed6acfb14',
  gate: '0x7a066511ce2e205b716df55bc5f8f03b74bca611',
  pool: '0x43446f24a860c9c13d138483275b879e16d614dd',
  guardian: '0xd3203e056ce71884a9a49fb73d7ec32349ff9a8b',
} as const;

/** The subTier-80 demo borrower this view is built around, see docs/OPEN_QUESTIONS.md's tier-spread investigation. */
export const DEMO_BORROWER = '0xd4D9F9787557Df143e962F1A42B2adA38687355A' as const;

/**
 * The block this demo's CURRENT open position started at (its fresh
 * attestation, block 52010383, minted 2026-08-08). The ledger reads
 * events from here forward, not from the pool's deploy block: Monad's
 * public testnet RPC caps eth_getLogs at 100 blocks (confirmed this
 * session, see docs/OPEN_QUESTIONS.md), so scanning the pool's entire
 * history on every page load isn't practical, and it isn't what this
 * view is for, it's a record of THIS lifecycle. Update this after
 * running backend/scripts/reset-demo-position*.ts again.
 */
export const DEMO_ORIGIN_BLOCK = 52010370n;
