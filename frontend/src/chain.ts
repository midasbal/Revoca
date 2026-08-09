import { createPublicClient, http, parseAbi, type Address } from 'viem';
import { monadTestnet } from 'viem/chains';
import { CHAIN_ID, DEPLOYMENT } from './deployment';

/**
 * Monad's own public testnet RPC, not a keyed/paid provider URL (no
 * embedded API key in the path), confirmed before using it client-side,
 * see docs/OPEN_QUESTIONS.md. Safe to ship in a browser bundle, unlike
 * anything in the repo's root .env.
 */
const DEFAULT_RPC_URL = 'https://testnet-rpc.monad.xyz';

export const RPC_URL = (import.meta.env.VITE_MONAD_RPC_URL as string | undefined) ?? DEFAULT_RPC_URL;

export const EXPLORER_BASE = 'https://testnet.monadscan.com';

/** viem's built-in monadTestnet chain definition carries the deployed Multicall3 address, needed so usePosition can batch seven reads into one request, see that hook's header for why that matters on Monad's rate-limited public RPC. */
export const publicClient = createPublicClient({
  chain: monadTestnet,
  transport: http(RPC_URL),
});

export { CHAIN_ID, DEPLOYMENT };

export const POOL_ABI = parseAbi([
  'function positions(address) external view returns (uint256 collateral, uint256 principal, uint256 accruedInterest, uint256 lastAccrualTimestamp)',
  'function currentDebt(address) external view returns (uint256)',
  'function currentRatioBps(address) external view returns (uint16)',
  'function isHealthy(address) external view returns (bool)',
  'function postCollateral(uint256 amount) external',
  'function borrow(uint256 amount) external',
  'function repay(uint256 amount) external',
  'function withdrawCollateral(uint256 amount) external',
  'function deposit(uint256 amount) external',
  'function withdraw(uint256 amount) external',
  'function sharesOf(address) external view returns (uint256)',
  'function totalShares() external view returns (uint256)',
  'function shareValue(address lender) external view returns (uint256)',
  'function idleLiquidity() external view returns (uint256)',
  'function totalPrincipalOutstanding() external view returns (uint256)',
  'function totalCollateral() external view returns (uint256)',
  'function totalPooledAssets() external view returns (uint256)',
  'function currentUtilizationBps() external view returns (uint16)',
  'function currentInterestRateBpsPerSecond() external view returns (uint256)',
  'event Deposit(address indexed lender, uint256 amount, uint256 sharesMinted, uint256 totalShares)',
  'event Withdraw(address indexed lender, uint256 amount, uint256 sharesBurned, uint256 totalShares)',
  'event CollateralPosted(address indexed borrower, uint256 amount, uint256 newCollateralBalance)',
  'event Borrow(address indexed borrower, uint256 amount, uint256 newPrincipal, uint256 newDebt, uint16 tier, uint16 subTier, uint16 ratioBps)',
  'event Repay(address indexed borrower, uint256 amount, uint256 principalPaid, uint256 interestPaid, uint256 remainingDebt)',
  'event CollateralWithdrawn(address indexed borrower, uint256 amount, uint256 newCollateralBalance)',
  'event Liquidate(address indexed borrower, address indexed liquidator, uint256 debtRepaid, uint256 collateralSeized, uint256 remainingCollateral)',
  'event CollateralAppliedToDebt(address indexed borrower, uint256 amountApplied, uint256 principalPaid, uint256 interestPaid, uint256 remainingDebt, uint256 remainingCollateral)',
]);

export const REGISTRY_ABI = parseAbi([
  'function isCompliant(address user) external view returns (bool)',
  'function isFresh(address user) external view returns (bool)',
  'function tierOf(address user) external view returns (uint16 tier, uint16 subTier)',
]);

/** The pool's actual gate, HybridComplianceGate on the current deployment, this is what `borrow()` really checks, not ComplianceRegistry directly (see docs/ARCHITECTURE.md's hybrid design). */
export const GATE_ABI = parseAbi([
  'function isCompliant(address user) external view returns (bool)',
  'function isFresh(address user) external view returns (bool)',
]);

export const ASSET_ABI = parseAbi([
  'function balanceOf(address) external view returns (uint256)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function approve(address spender, uint256 value) external returns (bool)',
  'function symbol() external view returns (string)',
]);

/** CompliancePolicy's ratio-band table, the real tier-as-risk data the borrower surface shows, never a hardcoded copy. */
export const POLICY_ABI = parseAbi([
  'function ratioBandCount() external view returns (uint256)',
  'function ratioBandAt(uint256 index) external view returns (uint16 minTier, uint16 minSubTier, uint16 ratioBps)',
]);

export const GUARDIAN_ABI = parseAbi([
  'function positions(address) external view returns (uint8 state, uint8 reason, uint256 flaggedAt, uint256 graceEndsAt, uint256 unwindStartedAt)',
  'event PositionFlagged(address indexed borrower, uint8 reason, uint256 graceEndsAt)',
  'event PositionReinstated(address indexed borrower)',
  'event UnwindStarted(address indexed borrower, uint256 debtAtStart, uint256 collateralAtStart)',
  'event UnwindStep(address indexed borrower, string step, uint256 amount, uint256 remainingDebt)',
  'event UnwindCompleted(address indexed borrower, uint256 residualCollateral)',
]);

export const GuardianState = {
  HEALTHY: 0,
  FLAGGED: 1,
  UNWINDING: 2,
  RESOLVED: 3,
} as const;

export const GuardianReason = ['NONE', 'FROZEN', 'EXPIRED', 'BLACKLISTED', 'INELIGIBLE', 'TIER_DROP'] as const;

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function shortHash(hash: string): string {
  return `${hash.slice(0, 8)}…${hash.slice(-6)}`;
}

export function explorerTxUrl(hash: string): string {
  return `${EXPLORER_BASE}/tx/${hash}`;
}

export function explorerAddressUrl(address: Address): string {
  return `${EXPLORER_BASE}/address/${address}`;
}

/** Formats a raw 18-decimal token amount as a rounded, comma-grouped whole number, this project's convention (round displayed numbers, never show wei-level precision in the UI). */
export function formatAmount(raw: bigint): string {
  const whole = raw / 10n ** 18n;
  return whole.toLocaleString('en-US');
}

export function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(0)}%`;
}

/** Monad's public testnet RPC caps eth_getLogs at 100 blocks per request (confirmed empirically this session, see docs/OPEN_QUESTIONS.md), well under most providers' defaults, so every log read here is chunked rather than a single unbounded request. */
const LOG_CHUNK_BLOCKS = 90n;

export interface ChunkedLogsOptions {
  address: Address;
  events: readonly unknown[];
  fromBlock: bigint;
  toBlock: bigint;
}

export async function fetchLogsChunked({ address, events, fromBlock, toBlock }: ChunkedLogsOptions) {
  const results: Awaited<ReturnType<typeof publicClient.getLogs>> = [];
  for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK_BLOCKS) {
    const end = start + LOG_CHUNK_BLOCKS - 1n > toBlock ? toBlock : start + LOG_CHUNK_BLOCKS - 1n;
    // eslint-disable-next-line no-await-in-loop -- chunks must stay within the RPC's per-request block-range cap, sequential by design
    const chunk = await publicClient.getLogs({
      address,
      events: events as never,
      fromBlock: start,
      toBlock: end,
    });
    results.push(...chunk);
  }
  return results;
}
