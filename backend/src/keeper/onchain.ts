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
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { KeeperConfig } from "./config.js";
import { requireOnChainConfig } from "./config.js";
import type { ComplianceAttestation } from "../attestor/types.js";
import { computeBlockChunks } from "../shared/blockChunks.js";

// Phase 2b: the registry's write path is now EIP-712 signature-verified
// attestations (see contracts/src/ComplianceRegistry.sol), the old
// owner/keeper-gated `observeCompliance` no longer exists on-chain.
// `submitAttestation` is PERMISSIONLESS (trust is in the signature, not
// the sender), so the keeper's own key is used here purely to RELAY a
// pre-signed attestation (built by backend/src/attestor), not to sign one.
const REGISTRY_ABI = parseAbi([
  "struct ComplianceAttestation { address user; uint16 tier; uint16 subTier; bytes2 country; uint8 apassStatus; uint256 expiry; uint256 issuedAt; uint256 nonce; }",
  "function submitAttestation(ComplianceAttestation attestation, bytes signature) external",
  "function lastNonce(address user) external view returns (uint256)",
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

/**
 * Default width (in blocks) of each `eth_getLogs` request, see
 * backend/src/audit/reconstruct.ts's identical constant for the full
 * rationale: real RPC providers commonly cap `eth_getLogs` by block range
 * and/or response size, and a single unbounded request across a long-lived
 * pool's history can throw, or on some providers silently return a
 * truncated result. A range narrower than this constant simply resolves in
 * one chunk, identical to the old unchunked behavior.
 */
export const DEFAULT_LOG_CHUNK_BLOCKS = 10_000n;

/** Fetches every log for one event, across [fromBlock, toBlock], paged in `chunkBlocks`-wide requests and concatenated. */
async function fetchLogsChunked(
  publicClient: PublicClient,
  address: Address,
  event: unknown,
  fromBlock: bigint,
  toBlock: bigint,
  chunkBlocks: bigint,
): Promise<{ args: { borrower?: Address } }[]> {
  const allLogs: { args: { borrower?: Address } }[] = [];
  for (const chunk of computeBlockChunks(fromBlock, toBlock, chunkBlocks)) {
    const logs = await publicClient.getLogs({
      address,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      event: event as any,
      fromBlock: chunk.fromBlock,
      toBlock: chunk.toBlock,
    });
    allLogs.push(...(logs as unknown as { args: { borrower?: Address } }[]));
  }
  return allLogs;
}

export enum GuardianPositionState {
  HEALTHY = 0,
  FLAGGED = 1,
  UNWINDING = 2,
  RESOLVED = 3,
}

export type IntendedAction =
  | { kind: "submitAttestation"; attestation: ComplianceAttestation; signature: Hex }
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
  /** Discovers borrower addresses that have ever interacted with the pool, via CollateralPosted/Borrow event logs. `chunkBlocks` overrides DEFAULT_LOG_CHUNK_BLOCKS, real callers should leave it at the default; it exists for tests that need to force multiple chunks on a short-lived local chain. */
  discoverBorrowers(fromBlock: bigint, chunkBlocks?: bigint): Promise<Address[]>;
  getGuardianPosition(borrower: Address): Promise<GuardianPosition>;
  isPoolHealthy(borrower: Address): Promise<boolean>;
  currentDebt(borrower: Address): Promise<bigint>;
  /** The next valid nonce for `user` on ComplianceRegistry, `lastNonce(user) + 1`. Needed to build a fresh attestation before signing it. */
  getNextNonce(user: Address): Promise<bigint>;
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

  async function discoverBorrowers(fromBlock: bigint, chunkBlocks: bigint = DEFAULT_LOG_CHUNK_BLOCKS): Promise<Address[]> {
    if (!cfg.poolAddress) {
      throw new Error("discoverBorrowers requires LENDING_POOL_ADDRESS, not available in this mode");
    }
    const toBlock = await publicClient.getBlockNumber();
    const [collateralLogs, borrowLogs] = await Promise.all([
      fetchLogsChunked(publicClient, cfg.poolAddress, POOL_ABI[0], fromBlock, toBlock, chunkBlocks),
      fetchLogsChunked(publicClient, cfg.poolAddress, POOL_ABI[1], fromBlock, toBlock, chunkBlocks),
    ]);

    const borrowers = new Set<Address>();
    for (const log of [...collateralLogs, ...borrowLogs]) {
      const borrower = log.args.borrower;
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

  async function getNextNonce(user: Address): Promise<bigint> {
    if (!cfg.registryAddress) {
      throw new Error("getNextNonce requires COMPLIANCE_REGISTRY_ADDRESS");
    }
    const last = await publicClient.readContract({
      address: cfg.registryAddress,
      abi: REGISTRY_ABI,
      functionName: "lastNonce",
      args: [user],
    });
    return last + 1n;
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
      case "submitAttestation":
        if (!cfg.registryAddress) throw new Error("COMPLIANCE_REGISTRY_ADDRESS not configured");
        hash = await walletClient.writeContract({
          address: cfg.registryAddress,
          abi: REGISTRY_ABI,
          functionName: "submitAttestation",
          args: [action.attestation, action.signature],
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

  return { dryRun, discoverBorrowers, getGuardianPosition, isPoolHealthy, currentDebt, getNextNonce, execute };
}
