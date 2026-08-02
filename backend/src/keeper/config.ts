/**
 * Keeper-specific configuration, loaded from the same .env as the
 * Cleanverse client (see backend/src/cleanverse/config.ts). All chain
 * addresses/keys here are OPTIONAL for dry-run mode, dry-run only needs
 * the Cleanverse API credentials (to call query_apass) and never touches
 * an RPC or signs anything. They become required the moment `dryRun` is
 * false and the keeper actually needs to send transactions.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { config as loadDotenv } from "dotenv";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
loadDotenv({ path: resolve(REPO_ROOT, ".env") });

export interface KeeperConfig {
  /** This pool's absolute minimum tier for participation, see eligibility.ts's header. */
  poolMinTier: number;
  /** Milliseconds between poll cycles. */
  pollIntervalMs: number;
  /** Chain slug passed to Cleanverse calls, fixed to "monad" for this project, kept configurable for completeness. */
  chain: string;
  /** Deployed ComplianceRegistry address. Required only when dryRun is false. */
  registryAddress: `0x${string}` | undefined;
  /** Deployed RevocationGuardian address. Required only when dryRun is false. */
  guardianAddress: `0x${string}` | undefined;
  /** Deployed LendingPool address. Required only when dryRun is false. */
  poolAddress: `0x${string}` | undefined;
  /**
   * The keeper's OWN signing key, deliberately a separate env var from
   * DEPLOYER_PRIVATE_KEY, not reused. See docs/THREAT_MODEL.md item 5's
   * point on key separation: the keeper only needs `observeCompliance` /
   * `flag` / `reinstate` / `startUnwind` / `completeUnwind` authority, none
   * of which requires the pool/registry owner's or deployer's key.
   */
  keeperPrivateKey: `0x${string}` | undefined;
}

const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_POOL_MIN_TIER = 20; // see README note below on why this default

export function loadKeeperConfig(): KeeperConfig {
  return {
    poolMinTier: parseIntEnv("POOL_MIN_TIER", DEFAULT_POOL_MIN_TIER),
    pollIntervalMs: parseIntEnv("KEEPER_POLL_INTERVAL_MS", DEFAULT_POLL_INTERVAL_MS),
    chain: process.env["KEEPER_CHAIN"] || "monad",
    registryAddress: asHex(process.env["COMPLIANCE_REGISTRY_ADDRESS"]),
    guardianAddress: asHex(process.env["REVOCATION_GUARDIAN_ADDRESS"]),
    poolAddress: asHex(process.env["LENDING_POOL_ADDRESS"]),
    keeperPrivateKey: asHex(process.env["KEEPER_PRIVATE_KEY"]),
  };
}

export class MissingChainConfigError extends Error {
  constructor(public readonly missingVars: string[]) {
    super(
      `Missing chain config for non-dry-run keeper mode: ${missingVars.join(", ")}. ` +
        `Dry-run mode doesn't need these, set dryRun: true, or fill these in once contracts are deployed.`,
    );
    this.name = "MissingChainConfigError";
  }
}

/** Call before any non-dry-run on-chain action. Throws with a clear list of what's missing. */
export function requireOnChainConfig(cfg: KeeperConfig): asserts cfg is KeeperConfig & {
  registryAddress: `0x${string}`;
  guardianAddress: `0x${string}`;
  poolAddress: `0x${string}`;
  keeperPrivateKey: `0x${string}`;
} {
  const missing: string[] = [];
  if (!cfg.registryAddress) missing.push("COMPLIANCE_REGISTRY_ADDRESS");
  if (!cfg.guardianAddress) missing.push("REVOCATION_GUARDIAN_ADDRESS");
  if (!cfg.poolAddress) missing.push("LENDING_POOL_ADDRESS");
  if (!cfg.keeperPrivateKey) missing.push("KEEPER_PRIVATE_KEY");
  if (missing.length > 0) throw new MissingChainConfigError(missing);
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asHex(raw: string | undefined): `0x${string}` | undefined {
  if (!raw) return undefined;
  return (raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`;
}
