/**
 * SPIKE / PROBE SCRIPT. Not part of the real keeper/attestor/audit paths,
 * and does NOT call `validator/register` or send any transaction. Purely
 * local computation, demonstrating the exact byte-level difference between
 * two candidate readings of docs/cleanverse2.pdf section 5.4's signature
 * rule ("keccak256(chain + contract_address), lowercase hex
 * concatenation"), so docs/DESIGN_A_SPIKE.md's analysis names concrete
 * bytes instead of describing them only in prose.
 *
 * Uses a well-known, public, throwaway anvil dev key (same one already
 * used across this repo's local rehearsal tests, holds no real value) as
 * the "owner" for demonstration purposes only. A real window attempt at
 * `validator/register` would need to sign with the actual on-chain
 * owner's key, this script never touches that.
 *
 * Run with: npx tsx scripts/spike-signature-schemes.ts
 */
import { keccak256, recoverMessageAddress, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildOwnerSignatureMessage } from "../src/cleanverse/signature.js";

// Anvil's well-known default dev key #1, public, holds no real value.
const DEMO_OWNER_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

const DEMO_CHAIN = "monad";
const DEMO_CONTRACT_ADDRESS: Address = "0xEA459EB91F7Dc1fF866282C1E80b9fdE7C4b297d";

async function main() {
  const account = privateKeyToAccount(DEMO_OWNER_PK);
  const message = buildOwnerSignatureMessage(DEMO_CHAIN, DEMO_CONTRACT_ADDRESS);

  console.log(`owner address (demo key, not a real deployer key): ${account.address}`);
  console.log(`chain + contract_address string: "${message}"`);
  console.log("");

  // ------------------------------------------------------------------
  // Scheme A (current backend/src/cleanverse/signature.ts, matches the
  // OLD docs/cleanverse.pdf's documented EIP-191 personal_sign of the
  // raw string): personal_sign("monad0xea45...")
  // ------------------------------------------------------------------
  const schemeASignature = await account.signMessage({ message });
  console.log("Scheme A, personal_sign of the raw concatenated STRING (current signature.ts):");
  console.log(`  signature: ${schemeASignature}`);
  const schemeARecovered = await recoverMessageAddress({ message, signature: schemeASignature });
  console.log(`  recovers to: ${schemeARecovered} (${schemeARecovered.toLowerCase() === account.address.toLowerCase() ? "matches signer, as expected" : "MISMATCH, unexpected"})`);
  console.log("");

  // ------------------------------------------------------------------
  // Scheme B (candidate reading of the NEW guide's literal wording,
  // "keccak256(chain + contract_address)" as a distinct first step):
  // personal_sign(keccak256("monad0xea45...")) - sign the 32-byte HASH
  // as the EIP-191 message, the same pattern OpenZeppelin's
  // ECDSA.toEthSignedMessageHash(bytes32) exists for.
  // ------------------------------------------------------------------
  const innerHash: Hex = keccak256(toHex(message));
  console.log(`inner hash, keccak256(chain + contract_address): ${innerHash}`);
  const schemeBSignature = await account.signMessage({ message: { raw: innerHash } });
  console.log("Scheme B, personal_sign of the keccak256 HASH (candidate reading of the new guide):");
  console.log(`  signature: ${schemeBSignature}`);
  const schemeBRecovered = await recoverMessageAddress({ message: { raw: innerHash }, signature: schemeBSignature });
  console.log(`  recovers to: ${schemeBRecovered} (${schemeBRecovered.toLowerCase() === account.address.toLowerCase() ? "matches signer, as expected" : "MISMATCH, unexpected"})`);
  console.log("");

  console.log(`Scheme A and B signatures differ: ${schemeASignature !== schemeBSignature}`);
  console.log("");
  console.log("NOTE: neither scheme here covers a THIRD possibility, a raw (non-EIP-191,");
  console.log("no \"\\x19Ethereum Signed Message\" prefix) ECDSA signature directly over");
  console.log("the 32-byte hash. That scheme cannot be produced with a wallet's standard");
  console.log("personal_sign/eth_sign call at all, it needs low-level secp256k1 signing,");
  console.log("see docs/DESIGN_A_SPIKE.md for why it's flagged as a third candidate.");
}

main().catch((err) => {
  console.error("spike-signature-schemes failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
