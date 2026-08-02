/**
 * The signing half of Design B: reads a borrower's current A-Pass facts
 * (sandbox or local, same data-source split as
 * backend/src/keeper/cleanverseSource.ts) and produces
 * a signed EIP-712 ComplianceAttestation. Does NOT decide eligibility
 * (that's ComplianceRegistry.sol, on-chain, live) and does NOT submit
 * anything anywhere, see relay.ts for the on-chain write.
 */
import type { Address, Hex, LocalAccount } from "viem";
import type { CleanverseClient } from "../cleanverse/client.js";
import {
  mapRawFactsToAttestation,
  type ApassFactSource,
  type ComplianceAttestation,
  type Eip712Domain,
  type RawApassFactFields,
} from "./types.js";
import { signAttestation } from "./sign.js";

export interface SignedAttestation {
  attestation: ComplianceAttestation;
  signature: Hex;
}

export interface AttestDeps {
  factSource: ApassFactSource;
  /** Reads the next valid nonce for `user`, e.g. relay.ts's `getNextNonce`, backed by the deployed registry's `lastNonce(user) + 1`. Injected so this module never needs chain access itself. */
  getNextNonce: (user: Address) => Promise<bigint>;
  /** Injectable clock (unix seconds), keeps attestation issuedAt deterministic in tests. */
  now: () => number;
  /** The attestor's own signing account (see config.ts's ATTESTOR_PRIVATE_KEY). */
  account: LocalAccount;
  domain: Eip712Domain;
}

/**
 * Reads `user`'s current A-Pass facts, maps them to a ComplianceAttestation,
 * and signs it. The attestor vouches only for "this is what Cleanverse
 * reported, as of issuedAt", see ComplianceRegistry.sol's header for the
 * full attest-facts-not-a-verdict design principle.
 */
export async function attest(deps: AttestDeps, user: Address): Promise<SignedAttestation> {
  const raw = await deps.factSource(user);
  const nonce = await deps.getNextNonce(user);
  const attestation = mapRawFactsToAttestation(raw, user, nonce, BigInt(deps.now()));
  const signature = await signAttestation(deps.account, deps.domain, attestation);
  return { attestation, signature };
}

/**
 * SANDBOX MODE: wraps CleanverseClient into an ApassFactSource. Always
 * calls query_apass SINGULAR, same authoritative-endpoint rule as
 * keeper/cleanverseSource.ts (see docs/OPEN_QUESTIONS.md item 7 on why the
 * list endpoint is not used). Distinct from cleanverseSource.ts only in
 * that it additionally surfaces `countries`, which this attestor needs and
 * the keeper's eligibility path does not.
 */
export function cleanverseFactSource(client: CleanverseClient, chain: string): ApassFactSource {
  return async (address: string) => {
    const data = await client.queryApass({ chain, address });
    return {
      status: data.status,
      expirationTime: data.expirationTime,
      tier: data.tier,
      subTier: data.subTier,
      countries: data.countries,
    };
  };
}

/**
 * LOCAL SIMULATION ONLY, not a real Cleanverse data source. The single
 * in-process, script-controlled stand-in for "Cleanverse changed this
 * borrower's A-Pass state," for local-anvil rehearsals of the attestor path
 * without any network dependency. Never used for anything that touches real
 * funds or the real sandbox, see CLAUDE.md's "no mock data for compliance"
 * rule.
 */
export class LocalApassFactSimulator {
  private readonly records = new Map<string, RawApassFactFields>();

  /** LOCAL SIMULATION ONLY. Sets a borrower's simulated A-Pass fields directly. */
  set(address: string, fields: RawApassFactFields): void {
    this.records.set(address.toLowerCase(), fields);
  }

  /** LOCAL SIMULATION ONLY. Marks a borrower active/compliant at the given tier/subTier/country. */
  setActive(address: string, tier: number, subTier: number, country: string): void {
    this.set(address, { status: 1, expirationTime: null, tier: String(tier), subTier, countries: [country] });
  }

  /** LOCAL SIMULATION ONLY. Simulates Cleanverse freezing this borrower's A-Pass. */
  freeze(address: string, tier: number, subTier: number, country: string): void {
    this.set(address, { status: 2, expirationTime: null, tier: String(tier), subTier, countries: [country] });
  }

  get(address: string): RawApassFactFields {
    const record = this.records.get(address.toLowerCase());
    if (!record) {
      // Never observed -> unknown, not active. Matches the real API's
      // status-null-is-not-active handling.
      return { status: null, expirationTime: null, tier: null, subTier: null, countries: [] };
    }
    return record;
  }

  asFactSource(): ApassFactSource {
    return async (address: string) => this.get(address);
  }
}
