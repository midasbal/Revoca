/**
 * Loads and validates the Cleanverse/Monad environment configuration from
 * .env. Never logs the values it loads, callers that need to display
 * something for debugging should use `redact()` below.
 *
 * Stack note: uses `dotenv` for .env loading (Node's own `--env-file` flag
 * would also work on Node 20+, but dotenv is more portable across the
 * scripts/tests/build entry points here).
 */
import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// .env lives at the repo root (backend/, contracts/, frontend/ are siblings
// under it), not inside backend/, resolve relative to this file rather
// than relying on process.cwd(), so `npm run <script>` works the same
// whether invoked from the repo root or from backend/.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
loadDotenv({ path: resolve(REPO_ROOT, ".env") });

export interface CleanverseConfig {
  apiId: string;
  apiKey: string;
  sandboxUrl: string;
  monadTestnetRpc: string;
  deployerPrivateKey: `0x${string}`;
}

const REQUIRED_ENV_VARS = [
  "CLEANVERSE_API_ID",
  "CLEANVERSE_API_KEY",
  "CLEANVERSE_SANDBOX_URL",
] as const;

/** Env vars only needed by scripts that touch chain RPC/signing, not the API client itself. */
const CHAIN_ENV_VARS = ["MONAD_TESTNET_RPC", "DEPLOYER_PRIVATE_KEY"] as const;

export class MissingConfigError extends Error {
  constructor(public readonly missingVars: string[]) {
    super(
      `Missing required environment variable(s): ${missingVars.join(", ")}. ` +
        `Copy .env.example to .env and fill in real values.`,
    );
    this.name = "MissingConfigError";
  }
}

/**
 * Shows at most the first 4 characters of a secret, for log/error-message
 * use. Never pass a full secret to a logger, use this instead.
 */
export function redact(value: string | undefined): string {
  if (!value) return "<empty>";
  if (value.length <= 4) return "*".repeat(value.length);
  return `${value.slice(0, 4)}${"*".repeat(Math.max(value.length - 4, 4))}`;
}

/**
 * Loads config for API-only usage (client, crypto). Does not require chain
 * RPC/deployer key, those are validated separately by loadChainConfig()
 * since not every caller needs them (e.g. the API client alone doesn't).
 */
export function loadConfig(): CleanverseConfig {
  const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new MissingConfigError(missing);
  }

  const rpc = process.env["MONAD_TESTNET_RPC"] ?? "";
  const pk = process.env["DEPLOYER_PRIVATE_KEY"] ?? "";

  return {
    apiId: process.env["CLEANVERSE_API_ID"]!,
    apiKey: process.env["CLEANVERSE_API_KEY"]!,
    sandboxUrl: process.env["CLEANVERSE_SANDBOX_URL"]!,
    monadTestnetRpc: rpc,
    deployerPrivateKey: normalizePrivateKey(pk),
  };
}

/**
 * Validates that the chain-related env vars (RPC + deployer key) are also
 * present. Call this from anything that actually needs to sign or read
 * on-chain state (e.g. the owner-signature helper), not from the plain API
 * client, so client-only tests/scripts don't need a funded deployer key.
 */
export function requireChainConfig(cfg: CleanverseConfig): void {
  const missing: string[] = [];
  if (!cfg.monadTestnetRpc) missing.push("MONAD_TESTNET_RPC");
  if (!cfg.deployerPrivateKey || cfg.deployerPrivateKey === "0x") {
    missing.push("DEPLOYER_PRIVATE_KEY");
  }
  if (missing.length > 0) {
    throw new MissingConfigError(missing);
  }
}

function normalizePrivateKey(pk: string): `0x${string}` {
  if (!pk) return "0x" as `0x${string}`;
  return (pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`;
}

// Re-export for callers that want to know which vars are considered required,
// e.g. a setup script printing what's missing without needing to construct
// the error itself.
export { REQUIRED_ENV_VARS, CHAIN_ENV_VARS };
