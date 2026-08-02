/**
 * Shared types for the EIP-712 attestation service (Phase 2b, Design B's
 * real spine, see docs/ROADMAP.md and contracts/src/ComplianceRegistry.sol's
 * header for the full design). This module fixes ONE thing very precisely:
 * the exact shape of a ComplianceAttestation and the EIP-712 domain/types
 * used to sign it, so that `sign.ts`'s viem-side signing and
 * ComplianceRegistry.sol's on-chain verification hash the IDENTICAL bytes.
 * See backend/test/attestation-anvil-crosscheck.test.ts for the proof.
 *
 * Field order/types here MUST match ComplianceRegistry.sol's
 * `ComplianceAttestation` struct and `COMPLIANCE_ATTESTATION_TYPEHASH`
 * exactly:
 *   ComplianceAttestation(address user,uint16 tier,uint16 subTier,
 *     bytes2 country,uint8 apassStatus,uint256 expiry,uint256 issuedAt,
 *     uint256 nonce)
 */
import type { Address, Hex } from "viem";
import { parseApiTier } from "../risk/tierRatios.js";

/** Matches ComplianceRegistry.sol's APASS_STATUS_* constants exactly. */
export const APASS_STATUS_UNKNOWN = 0;
export const APASS_STATUS_ACTIVE = 1;
export const APASS_STATUS_FROZEN = 2;

/**
 * The exact facts this attestor vouches for. NOT a verdict, no
 * "compliant" field exists here on purpose. Eligibility is derived
 * on-chain, live, by ComplianceRegistry from these facts + CompliancePolicy
 * (see ComplianceRegistry.sol's header for why).
 */
export interface ComplianceAttestation {
  user: Address;
  tier: number;
  subTier: number;
  /** bytes2 alpha-2 country code, e.g. 0x5553 for "US". 0x0000 = unknown/unmapped. */
  country: Hex;
  apassStatus: number;
  /** Unix seconds; 0 = no expiration (matches the contract's convention). */
  expiry: bigint;
  /** When these facts were read/signed, unix seconds. */
  issuedAt: bigint;
  nonce: bigint;
}

/** The EIP-712 typed-data `types` field, passed to viem's signTypedData/recoverTypedDataAddress verbatim. */
export const COMPLIANCE_ATTESTATION_TYPES = {
  ComplianceAttestation: [
    { name: "user", type: "address" },
    { name: "tier", type: "uint16" },
    { name: "subTier", type: "uint16" },
    { name: "country", type: "bytes2" },
    { name: "apassStatus", type: "uint8" },
    { name: "expiry", type: "uint256" },
    { name: "issuedAt", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export const COMPLIANCE_ATTESTATION_PRIMARY_TYPE = "ComplianceAttestation" as const;

/** Matches ComplianceRegistry.sol's `EIP712("Revoca", "1")` constructor call exactly. */
export interface Eip712Domain {
  name: "Revoca";
  version: "1";
  chainId: number;
  verifyingContract: Address;
}

export function buildDomain(chainId: number, verifyingContract: Address): Eip712Domain {
  return { name: "Revoca", version: "1", chainId, verifyingContract };
}

/** bytes2(0x0000), "no country recorded," distinct from any real alpha-2 code. */
export const NO_COUNTRY: Hex = "0x0000";

/** Converts a 2-letter ISO 3166-1 alpha-2 code (e.g. "US") to the raw bytes2 Cleanverse/CompliancePolicy use, e.g. "US" -> 0x5553. Same convention as contracts/src/CompliancePolicy.sol's header. */
export function countryAlpha2ToBytes2(alpha2: string): Hex {
  if (!/^[A-Za-z]{2}$/.test(alpha2)) {
    throw new Error(`Expected a 2-letter ISO 3166-1 alpha-2 country code, got: ${JSON.stringify(alpha2)}`);
  }
  const hex = Buffer.from(alpha2.toUpperCase(), "ascii").toString("hex");
  return `0x${hex}` as Hex;
}

/** Raw A-Pass fields the attestor needs, in query_apass's own shape (tier as a string, countries as an array). A superset of keeper/classify.ts's RawApassFields, the attestor additionally needs `countries`, which the keeper's eligibility path never reads. */
export interface RawApassFactFields {
  status: number | null | undefined;
  expirationTime: number | null | undefined;
  tier: string | null | undefined;
  subTier: number | null | undefined;
  countries: string[] | null | undefined;
}

/** Fetches the raw A-Pass fact fields for one address, from wherever this source gets its data (sandbox or local, see attest.ts). */
export type ApassFactSource = (address: string) => Promise<RawApassFactFields>;

/**
 * Maps one query_apass-shaped record to the exact facts this attestor signs
 * for `user`. Deliberately narrow, with every ambiguity resolved by an
 * explicit, documented rule rather than a silent guess:
 *
 * - `status`: 1 -> ACTIVE, 2 -> FROZEN, anything else (including null) ->
 *   UNKNOWN. Matches ComplianceRegistry.sol's APASS_STATUS_UNKNOWN
 *   fallback, an attestor never has to lie about an unexpected value.
 * - `tier`/`subTier`: absent/unparseable -> 0. Mirrors
 *   backend/src/keeper/poller.ts's `tier ?? 0` convention. This is safe
 *   under CompliancePolicy's default (minTier=0 means "no restriction");
 *   if a real floor is configured, tier 0 will correctly fail it rather
 *   than passing on missing data.
 * - `countries`: Cleanverse's real records are near-universally
 *   single-country (docs/TIER_DISTRIBUTION.md). Empty array -> NO_COUNTRY
 *   (0x0000). Multi-country array -> `countries[0]`, a deliberate,
 *   documented choice (see docs/OPEN_QUESTIONS.md) since Cleanverse's API
 *   has no documented precedence rule for this case, NOT a guess at
 *   hidden API behavior, just a fixed tie-break.
 * - `expirationTime`: null/undefined -> 0 (the contract's "no expiration"
 *   sentinel).
 */
export function mapRawFactsToAttestation(
  raw: RawApassFactFields,
  user: Address,
  nonce: bigint,
  issuedAt: bigint,
): ComplianceAttestation {
  const apassStatus =
    raw.status === 1 ? APASS_STATUS_ACTIVE : raw.status === 2 ? APASS_STATUS_FROZEN : APASS_STATUS_UNKNOWN;
  const tier = parseApiTier(raw.tier ?? null) ?? 0;
  const subTier = raw.subTier ?? 0;
  const countries = raw.countries ?? [];
  const country = countries.length > 0 ? countryAlpha2ToBytes2(countries[0]!) : NO_COUNTRY;
  const expiry = raw.expirationTime != null ? BigInt(raw.expirationTime) : 0n;

  return { user, tier, subTier, country, apassStatus, expiry, issuedAt, nonce };
}
