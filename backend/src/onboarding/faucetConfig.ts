/**
 * Faucet-specific configuration, loaded from the same .env as the
 * Cleanverse client, keeper, and attestor (see backend/src/cleanverse/
 * config.ts, backend/src/keeper/config.ts, backend/src/attestor/config.ts).
 * FAUCET_PRIVATE_KEY is deliberately its OWN, separate env var, never
 * DEPLOYER_PRIVATE_KEY: gas-funding-on-demand for any connected wallet is
 * a much higher-frequency, lower-trust operation (anyone who connects a
 * wallet can trigger it) than deployment or attestation, so it gets its
 * own small, replenishable balance rather than sharing the deployer's
 * key and exposure, see fund.ts's fundGasOnly.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, LocalAccount } from "viem";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
loadDotenv({ path: resolve(REPO_ROOT, ".env") });

export interface FaucetConfig {
  /** The faucet's own funding key. Undefined until configured, required only once fundGasOnly() is actually called. */
  faucetPrivateKey: `0x${string}` | undefined;
}

export function loadFaucetConfig(): FaucetConfig {
  return { faucetPrivateKey: asHex(process.env["FAUCET_PRIVATE_KEY"]) };
}

export class MissingFaucetKeyError extends Error {
  constructor() {
    super(
      "FAUCET_PRIVATE_KEY is not set. Set it in .env to fund gas for connected " +
        "wallets (never commit a real value, see .env.example and CLAUDE.md's " +
        "Secrets section).",
    );
    this.name = "MissingFaucetKeyError";
  }
}

/** Call before funding anything. Throws a clear error if the key is missing. */
export function requireFaucetKey(cfg: FaucetConfig): asserts cfg is FaucetConfig & {
  faucetPrivateKey: `0x${string}`;
} {
  if (!cfg.faucetPrivateKey) throw new MissingFaucetKeyError();
}

/** Builds the faucet's viem signing account from config. */
export function faucetAccountFromConfig(cfg: FaucetConfig): LocalAccount {
  requireFaucetKey(cfg);
  return privateKeyToAccount(cfg.faucetPrivateKey);
}

/** The faucet's address, derived from FAUCET_PRIVATE_KEY, safe to log/share; the private key itself never is. */
export function faucetAddress(cfg: FaucetConfig): Address {
  return faucetAccountFromConfig(cfg).address;
}

function asHex(raw: string | undefined): `0x${string}` | undefined {
  if (!raw) return undefined;
  return (raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`;
}
