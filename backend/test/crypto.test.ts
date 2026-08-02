import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptBody, encryptBody } from "../src/cleanverse/crypto.js";

/**
 * If .env has a real CLEANVERSE_API_KEY, exercise the round-trip with it,
 * that's the key we'll actually use against the sandbox. Otherwise (e.g.
 * this repo's .env still has the blank placeholder from setup), fall back
 * to a locally generated 32-byte AES-256 key so the test still verifies
 * crypto.ts's own correctness. Either way this only proves internal
 * consistency (encrypt then decrypt returns the original), NOT that our
 * scheme matches Cleanverse's. See the skipped test below for why that
 * still needs a live call.
 */
function testApiKey(): string {
  const envKey = process.env["CLEANVERSE_API_KEY"];
  if (envKey && envKey.length > 0) return envKey;
  return randomBytes(32).toString("base64");
}

describe("crypto round-trip", () => {
  it("encrypts then decrypts back to the original payload (zero-iv, default mode)", () => {
    const apiKey = testApiKey();
    const payload = { chain: "monad", contract_address: "0xabc", nested: { ok: true, n: 42 } };

    const encrypted = encryptBody(payload, apiKey);
    const decrypted = decryptBody<typeof payload>(encrypted, apiKey);

    expect(decrypted).toEqual(payload);
  });

  it("produces different ciphertext for different payloads (sanity check, not a security claim)", () => {
    const apiKey = testApiKey();
    const a = encryptBody({ a: 1 }, apiKey);
    const b = encryptBody({ a: 2 }, apiKey);
    expect(a).not.toEqual(b);
  });

  it("round-trips through key-prefix-iv mode when explicitly selected", () => {
    const apiKey = testApiKey();
    const payload = { hello: "world" };
    const encrypted = encryptBody(payload, apiKey, "key-prefix-iv");
    const decrypted = decryptBody<typeof payload>(encrypted, apiKey, "key-prefix-iv");
    expect(decrypted).toEqual(payload);
  });

  it("round-trips through random-iv-prepended mode when explicitly selected", () => {
    const apiKey = testApiKey();
    const payload = { hello: "world" };
    const encrypted = encryptBody(payload, apiKey, "random-iv-prepended");
    const decrypted = decryptBody<typeof payload>(encrypted, apiKey, "random-iv-prepended");
    expect(decrypted).toEqual(payload);
  });

  /**
   * SKIPPED, this is the real validation, not the round-trip above.
   *
   * docs/cleanverse.pdf documents the AES scheme in prose (AES/CBC/PKCS5Padding,
   * fixed all-zero 16-byte IV, key = Base64-decoded api-key) but contains NO
   * genuine plaintext<->ciphertext worked example, every "encrypted request
   * body" example in the 153-page doc uses the same placeholder ciphertext
   * (Base64 of "helloworld" x11), not a real encryption of the adjacent
   * plaintext. A local round-trip test only proves our encrypt/decrypt are
   * inverses of each other; it cannot prove they match Cleanverse's actual
   * implementation (e.g. if the true IV strategy or padding differs from what's
   * documented).
   *
   * The only real proof is decrypting a genuine encrypted RESPONSE from the
   * live sandbox. That requires calling an encrypted endpoint (update_status,
   * generate_apass, or any validator/* mutation), all of which require a
   * sandbox role we haven't confirmed yet (see docs/OPEN_QUESTIONS.md item 1).
   *
   * Un-skip this once backend/scripts/probe.ts (or a follow-up script) has
   * made one real encrypted call and captured a genuine response `data`
   * field, paste it in as EXPECTED_CIPHERTEXT and assert the decrypt
   * produces the expected plaintext shape.
   */
  it.skip("decrypts a genuine Cleanverse encrypted response (blocked on live encrypted call, see docs/OPEN_QUESTIONS.md item 4)", () => {
    // Intentionally left unimplemented until we have a real captured response.
  });
});
