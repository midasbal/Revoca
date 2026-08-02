/**
 * Owner-signature helper for `validator/register` and `validator/grant`.
 *
 * Stack note: uses `viem` for EIP-191 personal_sign + signature recovery.
 *
 * Per docs/cleanverse.pdf (p.73-74, "Owner Signature (grant and register
 * only)"):
 *   - Algorithm: EIP-191 personal_sign, hex-encoded, 65 bytes.
 *   - Signed message: lowercase chain slug concatenated with a lowercase hex
 *     address (0x retained), no separator. Exact PDF example:
 *     "base0x742d35cc6634c0532925a3b844bc9e7595f0beb0"
 *   - `register` signs chain + contract_address (the pool being registered).
 *   - `grant` signs chain + address (the account receiving the registrar role).
 *   - Cleanverse verifies the signature was produced by the on-chain owner()
 *     of the subject address.
 */
import {
  recoverMessageAddress,
  type Address,
  type LocalAccount,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Builds the exact message string Cleanverse expects: lowercase chain slug
 * directly concatenated with the lowercase hex address, no separator.
 */
export function buildOwnerSignatureMessage(chain: string, address: Address | string): string {
  return `${chain.toLowerCase()}${address.toLowerCase()}`;
}

/**
 * Produces the owner_signature field for validator/register or
 * validator/grant. `account` is the contract owner's signing account,
 * callers construct it from DEPLOYER_PRIVATE_KEY (via accountFromPrivateKey)
 * for real use, or from any test key for deterministic unit tests.
 *
 * For `register`, pass the pool's contract_address as `address`.
 * For `grant`, pass the registrar-role recipient's address as `address`.
 */
export async function ownerSignature(
  chain: string,
  address: Address | string,
  account: LocalAccount,
): Promise<`0x${string}`> {
  const message = buildOwnerSignatureMessage(chain, address);
  return account.signMessage({ message });
}

/**
 * Recovers the signer address from a message + signature pair. Used by the
 * deterministic unit test, and useful for local sanity-checking a signature
 * before sending it to Cleanverse.
 */
export async function recoverOwnerSigner(
  chain: string,
  address: Address | string,
  signature: `0x${string}`,
): Promise<Address> {
  const message = buildOwnerSignatureMessage(chain, address);
  return recoverMessageAddress({ message, signature });
}

/** Constructs a viem LocalAccount from a raw hex private key (e.g. DEPLOYER_PRIVATE_KEY). */
export function accountFromPrivateKey(privateKey: `0x${string}`): LocalAccount {
  return privateKeyToAccount(privateKey);
}
