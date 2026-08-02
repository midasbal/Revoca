/**
 * Signs and verifies an AuditReport. See docs/AUDIT_REPORT.md Part 3: the
 * canonical JSON report is hashed with keccak256, and the hash is signed
 * EIP-191 (`personal_sign`) by the attestor key (same key as
 * ComplianceRegistry attestations, ATTESTOR_PRIVATE_KEY), so a third party
 * can verify the report was produced by, and hasn't been altered since, the
 * holder of that key. This does NOT reuse the EIP-712 attestation
 * machinery (that's for signing ComplianceAttestation structs, a different
 * message shape); a plain EIP-191 signature over the report hash is
 * sufficient and simpler for "the backend vouches this exact report is
 * genuine."
 */
import { keccak256, recoverMessageAddress, stringToHex, type Address, type Hex, type LocalAccount } from "viem";
import type { AuditReport, SignedReport } from "./types.js";

/** Deterministic JSON stringify: object keys sorted recursively, so the same report always hashes to the same value regardless of property insertion order. */
export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export function hashReport(report: AuditReport): Hex {
  return keccak256(stringToHex(canonicalJsonStringify(report)));
}

export async function signReport(account: LocalAccount, report: AuditReport): Promise<SignedReport> {
  const reportHash = hashReport(report);
  const signature = await account.signMessage({ message: { raw: reportHash } });
  return { report, reportHash, signature, signer: account.address };
}

/** Recomputes the report hash from `signed.report` and recovers the signer, returns whether it matches `signed.signer` (recovered-address integrity) and, if `expectedSigner` is provided, whether it matches that specific address (authenticity against a known attestor). A tampered report (any byte changed) recomputes to a different hash, so the recovered signer will not match the original signature. */
export async function verifyReport(
  signed: SignedReport,
  expectedSigner?: Address,
): Promise<{ hashMatches: boolean; signatureValid: boolean; signerMatchesExpected: boolean | null }> {
  const recomputedHash = hashReport(signed.report);
  const hashMatches = recomputedHash === signed.reportHash;

  let recovered: Address | undefined;
  try {
    recovered = await recoverMessageAddress({ message: { raw: recomputedHash }, signature: signed.signature });
  } catch {
    recovered = undefined;
  }

  const signatureValid = hashMatches && recovered?.toLowerCase() === signed.signer.toLowerCase();
  const signerMatchesExpected = expectedSigner ? recovered?.toLowerCase() === expectedSigner.toLowerCase() : null;

  return { hashMatches, signatureValid, signerMatchesExpected };
}
