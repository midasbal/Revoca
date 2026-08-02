/**
 * On-chain interaction layer for the keeper: writes to ComplianceRegistry
 * and drives RevocationGuardian's state machine. Every write goes through
 * `dryRun`, when true, the intended call (target, function, args) is
 * logged and NOT sent; no RPC connection or signing key is touched at all
 * in that mode. This is what lets the keeper's decision logic be exercised
 * against the live Cleanverse sandbox without any contracts deployed yet.
 *
 * RPC/chain are passed in explicitly (not read from a hardcoded env var)
 * so the SAME driver code works against Monad testnet (sandbox mode) and a
 * local anvil instance (the end-to-end rehearsal, see
 * backend/test/e2e-local-rehearsal.test.ts), only the caller-supplied
 * `rpcUrl`/`chain` differ.
 *
 * Stack note: viem for chain interaction (already a dependency via
 * signature.ts). ABIs below are narrow, hand-written fragments (only the
 * functions/events the keeper actually calls) rather than the full
 * Forge-generated artifact, keeps the backend from needing a build step
 * wired to contracts/out.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Address,
  type Chain,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { KeeperConfig } from "./config.js";
import { requireOnChainConfig } from "./config.js";
import type { EligibilityReason } from "./eligibility.js";

const REGISTRY_ABI = parseAbi([
  "function observeCompliance(address user, bool compliant, uint16 tier, uint16 subTier, uint8 reason) external",
]);

const GUARDIAN_ABI = parseAbi([
  "function flag(address borrower) external",
  "function reinstate(address borrower) external",
  "function startUnwind(address borrower) external",
  "function completeUnwind(address borrower) external",
  "function positions(address borrower) external view returns (uint8 state, uint8 reason, uint256 flaggedAt, uint256 graceEndsAt, uint256 unwindStartedAt)",
]);

const POOL_ABI = parseAbi([
  "event CollateralPosted(address indexed borrower, uint256 amount, uint256 newCollateralBalance)",
  "event Borrow(address indexed borrower, uint256 amount, uint256 newPrincipal, uint256 newDebt, uint16 tier, uint16 subTier, uint16 ratioBps)",
  "function currentDebt(address borrower) external view returns (uint256)",
  "function isHealthy(address borrower) external view returns (bool)",
]);

export enum GuardianPositionState {
  HEALTHY = 0,
  FLAGGED = 1,
  UNWINDING = 2,
  RESOLVED = 3,
}

export type IntendedAction =
  | { kind: "observeCompliance"; user: Address; compliant: boolean; tier: number; subTier: number; reason: EligibilityReason }
  | { kind: "flag"; borrower: Address }
  | { kind: "reinstate"; borrower: Address }
  | { kind: "startUnwind"; borrower: Address }
  | { kind: "completeUnwind"; borrower: Address };

export interface GuardianPosition {
  state: GuardianPositionState;
  reason: number;
  flaggedAt: bigint;
  graceEndsAt: bigint;
  unwindStartedAt: bigint;
}

export interface OnChainDriver {
  dryRun: boolean;
  /** Discovers borrower addresses that have ever interacted with the pool, via CollateralPosted/Borrow event logs. */
  discoverBorrowers(fromBlock: bigint): Promise<Address[]>;
  getGuardianPosition(borrower: Address): Promise<GuardianPosition>;
  isPoolHealthy(borrower: Address): Promise<boolean>;
  currentDebt(borrower: Address): Promise<bigint>;
  /** Executes (or, in dry-run, logs) the given action. Waits for the transaction receipt before resolving (skipped in dry-run, where nothing is sent). Returns the tx hash if actually sent. */
  execute(action: IntendedAction): Promise<`0x${string}` | null>;
}

export interface OnChainDriverOptions {
  /** JSON-RPC URL, e.g. MONAD_TESTNET_RPC for sandbox mode, or http://127.0.0.1:8545 for the local anvil rehearsal. */
  rpcUrl: string;
  /** viem Chain config for the wallet client (needed for tx signing/chain-id checks). Omit for a public-client-only (read/dry-run) driver. */
  chain?: Chain;
}

export function createOnChainDriver(cfg: KeeperConfig, dryRun: boolean, opts: OnChainDriverOptions): OnChainDriver {
  if (!dryRun) {
    requireOnChainConfig(cfg);
  }

  // cacheTime: 0, without it, viem caches getBlockNumber() results for a
  // few seconds, which is fine for a slow real chain but actively wrong
  // for the local anvil rehearsal, where many blocks are mined within that
  // window and callers need the true current block every time.
  const publicClient: PublicClient = createPublicClient({ transport: http(opts.rpcUrl), cacheTime: 0 });

  const account = !dryRun && cfg.keeperPrivateKey ? privateKeyToAccount(cfg.keeperPrivateKey) : undefined;
  const walletClient: WalletClient | undefined =
    !dryRun && account
      ? createWalletClient({ account, chain: opts.chain, transport: http(opts.rpcUrl) })
      : undefined;

  async function discoverBorrowers(fromBlock: bigint): Promise<Address[]> {
    if (!cfg.poolAddress) {
      throw new Error("discoverBorrowers requires LENDING_POOL_ADDRESS, not available in this mode");
    }
    const [collateralLogs, borrowLogs] = await Promise.all([
      publicClient.getLogs({
        address: cfg.poolAddress,
        event: POOL_ABI[0],
        fromBlock,
        toBlock: "latest",
      }),
      publicClient.getLogs({
        address: cfg.poolAddress,
        event: POOL_ABI[1],
        fromBlock,
        toBlock: "latest",
      }),
    ]);

    const borrowers = new Set<Address>();
    for (const log of [...collateralLogs, ...borrowLogs]) {
      const borrower = (log as unknown as { args: { borrower: Address } }).args.borrower;
      if (borrower) borrowers.add(borrower);
    }
    return [...borrowers];
  }

  async function getGuardianPosition(borrower: Address): Promise<GuardianPosition> {
    if (!cfg.guardianAddress) {
      throw new Error("getGuardianPosition requires REVOCATION_GUARDIAN_ADDRESS");
    }
    const [state, reason, flaggedAt, graceEndsAt, unwindStartedAt] = await publicClient.readContract({
      address: cfg.guardianAddress,
      abi: GUARDIAN_ABI,
      functionName: "positions",
      args: [borrower],
    });
    return {
      state: Number(state) as GuardianPositionState,
      reason: Number(reason),
      flaggedAt,
      graceEndsAt,
      unwindStartedAt,
    };
  }

  async function isPoolHealthy(borrower: Address): Promise<boolean> {
    if (!cfg.poolAddress) {
      throw new Error("isPoolHealthy requires LENDING_POOL_ADDRESS");
    }
    return publicClient.readContract({
      address: cfg.poolAddress,
      abi: POOL_ABI,
      functionName: "isHealthy",
      args: [borrower],
    });
  }

  async function currentDebt(borrower: Address): Promise<bigint> {
    if (!cfg.poolAddress) {
      throw new Error("currentDebt requires LENDING_POOL_ADDRESS");
    }
    return publicClient.readContract({
      address: cfg.poolAddress,
      abi: POOL_ABI,
      functionName: "currentDebt",
      args: [borrower],
    });
  }

  async function execute(action: IntendedAction): Promise<`0x${string}` | null> {
    if (dryRun) {
      console.log(`[dry-run] would execute: ${JSON.stringify(action)}`);
      return null;
    }

    if (!walletClient || !account) {
      throw new Error("execute() called in non-dry-run mode without a signing account configured");
    }

    let hash: `0x${string}`;
    switch (action.kind) {
      case "observeCompliance":
        if (!cfg.registryAddress) throw new Error("COMPLIANCE_REGISTRY_ADDRESS not configured");
        hash = await walletClient.writeContract({
          address: cfg.registryAddress,
          abi: REGISTRY_ABI,
          functionName: "observeCompliance",
          args: [action.user, action.compliant, action.tier, action.subTier, action.reason],
          account,
          chain: opts.chain,
        });
        break;
      case "flag":
        if (!cfg.guardianAddress) throw new Error("REVOCATION_GUARDIAN_ADDRESS not configured");
        hash = await walletClient.writeContract({
          address: cfg.guardianAddress,
          abi: GUARDIAN_ABI,
          functionName: "flag",
          args: [action.borrower],
          account,
          chain: opts.chain,
        });
        break;
      case "reinstate":
        if (!cfg.guardianAddress) throw new Error("REVOCATION_GUARDIAN_ADDRESS not configured");
        hash = await walletClient.writeContract({
          address: cfg.guardianAddress,
          abi: GUARDIAN_ABI,
          functionName: "reinstate",
          args: [action.borrower],
          account,
          chain: opts.chain,
        });
        break;
      case "startUnwind":
        if (!cfg.guardianAddress) throw new Error("REVOCATION_GUARDIAN_ADDRESS not configured");
        hash = await walletClient.writeContract({
          address: cfg.guardianAddress,
          abi: GUARDIAN_ABI,
          functionName: "startUnwind",
          args: [action.borrower],
          account,
          chain: opts.chain,
        });
        break;
      case "completeUnwind":
        if (!cfg.guardianAddress) throw new Error("REVOCATION_GUARDIAN_ADDRESS not configured");
        hash = await walletClient.writeContract({
          address: cfg.guardianAddress,
          abi: GUARDIAN_ABI,
          functionName: "completeUnwind",
          args: [action.borrower],
          account,
          chain: opts.chain,
        });
        break;
    }

    await publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  return { dryRun, discoverBorrowers, getGuardianPosition, isPoolHealthy, currentDebt, execute };
}
