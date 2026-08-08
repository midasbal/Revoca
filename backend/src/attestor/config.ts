/**
 * Attestor-specific configuration, loaded from the same .env as the
 * Cleanverse client and keeper (see backend/src/cleanverse/config.ts,
 * backend/src/keeper/config.ts). ATTESTOR_PRIVATE_KEY is deliberately a
 * SEPARATE env var from KEEPER_PRIVATE_KEY/DEPLOYER_PRIVATE_KEY, see
 * docs/THREAT_MODEL.md's attestor-key section: the attestor only needs
 * `submitAttestation` authority (granted via ComplianceRegistry.setAttestor
 * by the owner), never the keeper's flag/reinstate/startUnwind/
 * completeUnwind authority (which is permissionless anyway) or the
 * deployer/owner's key.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, LocalAccount } from "viem";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
loadDotenv({ path: resolve(REPO_ROOT, ".env") });

export interface AttestorConfig {
  /** The attestor's own signing key. Undefined until configured, required only once `attest()`/`signAttestation()` is actually called. */
  attestorPrivateKey: `0x${string}` | undefined;
  /** Deployed ComplianceRegistry address. Required only for on-chain relay (relay.ts). */
  registryAddress: `0x${string}` | undefined;
  /** Cleanverse chain slug, fixed to "monad" for this project, kept configurable for completeness. */
  chain: string;
}

export function loadAttestorConfig(): AttestorConfig {
  return {
    attestorPrivateKey: asHex(process.env["ATTESTOR_PRIVATE_KEY"]),
    registryAddress: asHex(process.env["COMPLIANCE_REGISTRY_ADDRESS"]),
    chain: process.env["KEEPER_CHAIN"] || "monad",
  };
}

export class MissingAttestorKeyError extends Error {
  constructor() {
    super(
      "ATTESTOR_PRIVATE_KEY is not set. Set it in .env to sign attestations " +
        "(never commit a real value, see .env.example and CLAUDE.md's Secrets section).",
    );
    this.name = "MissingAttestorKeyError";
  }
}

/** Call before signing anything. Throws a clear error if the key is missing. */
export function requireAttestorKey(cfg: AttestorConfig): asserts cfg is AttestorConfig & {
  attestorPrivateKey: `0x${string}`;
} {
  if (!cfg.attestorPrivateKey) throw new MissingAttestorKeyError();
}

/** Builds the attestor's viem signing account from config. Also exposes the derived address (e.g. for the owner to `setAttestor(address, true)` on-chain). */
export function attestorAccountFromConfig(cfg: AttestorConfig): LocalAccount {
  requireAttestorKey(cfg);
  return privateKeyToAccount(cfg.attestorPrivateKey);
}

/** The attestor's address, derived from ATTESTOR_PRIVATE_KEY, safe to log/share; the private key itself never is. */
export function attestorAddress(cfg: AttestorConfig): Address {
  return attestorAccountFromConfig(cfg).address;
}

function asHex(raw: string | undefined): `0x${string}` | undefined {
  if (!raw) return undefined;
  return (raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`;
}
