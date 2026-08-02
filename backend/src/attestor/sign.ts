/**
 * EIP-712 signing/recovery for ComplianceAttestations, via viem. This is
 * the off-chain half of the byte-for-byte cross-check with
 * ComplianceRegistry.sol's `_hashTypedDataV4`, same domain, same types,
 * same field order (see types.ts's header), proven in
 * backend/test/attestation-anvil-crosscheck.test.ts.
 */
import { recoverTypedDataAddress, type Address, type Hex, type LocalAccount } from "viem";
import {
  COMPLIANCE_ATTESTATION_PRIMARY_TYPE,
  COMPLIANCE_ATTESTATION_TYPES,
  type ComplianceAttestation,
  type Eip712Domain,
} from "./types.js";

/** Signs `attestation` as EIP-712 typed data under `domain`, using `account`'s key. */
export async function signAttestation(
  account: LocalAccount,
  domain: Eip712Domain,
  attestation: ComplianceAttestation,
): Promise<Hex> {
  return account.signTypedData({
    domain,
    types: COMPLIANCE_ATTESTATION_TYPES,
    primaryType: COMPLIANCE_ATTESTATION_PRIMARY_TYPE,
    message: attestation,
  });
}

/** Recovers the signer address from an attestation + signature pair, useful for sanity-checking a signature locally before relaying it (or in tests, to assert it matches the expected attestor address). */
export async function recoverAttestor(
  domain: Eip712Domain,
  attestation: ComplianceAttestation,
  signature: Hex,
): Promise<Address> {
  return recoverTypedDataAddress({
    domain,
    types: COMPLIANCE_ATTESTATION_TYPES,
    primaryType: COMPLIANCE_ATTESTATION_PRIMARY_TYPE,
    message: attestation,
    signature,
  });
}
