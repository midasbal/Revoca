import { describe, expect, it } from "vitest";
import {
  accountFromPrivateKey,
  buildOwnerSignatureMessage,
  ownerSignature,
  recoverOwnerSigner,
} from "../src/cleanverse/signature.js";

// Well-known Hardhat/Anvil default test account #0 private key, not a
// secret, used throughout the Ethereum tooling ecosystem for deterministic
// local tests. Never use this key for anything with real value.
const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

describe("buildOwnerSignatureMessage", () => {
  it("matches the exact PDF example format: lowercase chain + lowercase 0x-address, no separator", () => {
    // Exact example from docs/cleanverse.pdf p.73-74.
    const message = buildOwnerSignatureMessage("base", "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0");
    expect(message).toBe("base0x742d35cc6634c0532925a3b844bc9e7595f0beb0");
  });

  it("lowercases a mixed-case chain slug too", () => {
    const message = buildOwnerSignatureMessage("Monad", "0xABCDEF0123456789000000000000000000000001");
    expect(message).toBe("monad0xabcdef0123456789000000000000000000000001");
  });
});

describe("ownerSignature / recoverOwnerSigner", () => {
  it("signs deterministically and recovers back to the signer's own address", async () => {
    const account = accountFromPrivateKey(TEST_PRIVATE_KEY);
    const chain = "monad";
    const contractAddress = "0x00000000000000000000000000000000000001";

    const signature = await ownerSignature(chain, contractAddress, account);

    expect(signature).toMatch(/^0x[0-9a-f]{130}$/i); // 65 bytes hex = 130 hex chars + 0x
    expect(signature.length).toBe(2 + 130);

    const recovered = await recoverOwnerSigner(chain, contractAddress, signature);
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });

  it("produces a signature that does NOT recover to the signer for a different message", async () => {
    const account = accountFromPrivateKey(TEST_PRIVATE_KEY);
    const signature = await ownerSignature("monad", "0x00000000000000000000000000000000000001", account);

    // Same signature, different subject address -> different signed message -> different recovered signer.
    const recoveredForWrongMessage = await recoverOwnerSigner(
      "monad",
      "0x00000000000000000000000000000000000002",
      signature,
    );
    expect(recoveredForWrongMessage.toLowerCase()).not.toBe(account.address.toLowerCase());
  });

  it("register vs grant sign different subject fields (chain+contract_address vs chain+address), same helper, different caller-supplied subject", async () => {
    const account = accountFromPrivateKey(TEST_PRIVATE_KEY);
    const chain = "monad";
    const contractAddress = "0x00000000000000000000000000000000000001"; // used by register
    const grantee = "0x00000000000000000000000000000000000002"; // used by grant

    const registerSig = await ownerSignature(chain, contractAddress, account);
    const grantSig = await ownerSignature(chain, grantee, account);

    expect(registerSig).not.toBe(grantSig);
  });
});
