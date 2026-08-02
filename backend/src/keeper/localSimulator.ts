/**
 * LOCAL SIMULATION ONLY, not a real Cleanverse data source. This is a
 * deterministic, in-process, script-controlled stand-in for "Cleanverse
 * changed this borrower's A-Pass state," used exclusively by the local
 * anvil end-to-end rehearsal (backend/test/e2e-local-rehearsal.test.ts) so
 * that scenario can flip a borrower frozen/unfrozen on command, without any
 * network dependency, real sandbox call, or timing nondeterminism.
 *
 * NEVER use this for anything that touches real funds or the real sandbox
 *, see CLAUDE.md's "no mock data for compliance" rule. The rehearsal
 * exists specifically to prove the on-chain wiring and the keeper's write
 * path close the loop; the real classification path
 * (cleanverseSource.ts) is what actually talks to Cleanverse and is left
 * completely untouched by this file.
 */
import type { ApassDataSource, RawApassFields } from "./classify.js";

export class LocalApassSimulator {
  private readonly records = new Map<string, RawApassFields>();

  /** LOCAL SIMULATION ONLY. Sets a borrower's simulated A-Pass fields directly. */
  set(address: string, fields: RawApassFields): void {
    this.records.set(address.toLowerCase(), fields);
  }

  /** LOCAL SIMULATION ONLY. Marks a borrower as compliant at the given tier/subTier. */
  setCompliant(address: string, tier: number, subTier: number): void {
    this.set(address, { status: 1, expirationTime: null, tier: String(tier), subTier });
  }

  /** LOCAL SIMULATION ONLY. Simulates Cleanverse freezing this borrower's A-Pass. */
  freeze(address: string, tier: number, subTier: number): void {
    this.set(address, { status: 2, expirationTime: null, tier: String(tier), subTier });
  }

  get(address: string): RawApassFields {
    const record = this.records.get(address.toLowerCase());
    if (!record) {
      // Never observed -> unknown, not active. Matches the real API's
      // status-null-is-not-active handling (see eligibility.ts).
      return { status: null, expirationTime: null, tier: null, subTier: null };
    }
    return record;
  }

  asDataSource(): ApassDataSource {
    return async (address: string) => this.get(address);
  }
}
