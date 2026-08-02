/**
 * AES encrypt/decrypt for Cleanverse's "encrypted" endpoint bodies.
 *
 * Stack note: uses Node's built-in `node:crypto` (no extra dependency needed
 * for plain AES/CBC).
 *
 * Per docs/cleanverse.pdf (p.5-6), the documented scheme is:
 *   Encrypt: JSON.stringify(body) -> AES/CBC/PKCS5Padding, key = Base64-decode(api-key) -> Base64(ciphertext) -> {"data": "<base64>"}
 *   Decrypt: Base64-decode response.data -> AES/CBC/PKCS5Padding decrypt (same key) -> JSON.parse
 *   Cipher IV: "fixed IV of 16 zero bytes" (quoted verbatim from the PDF).
 *
 * PKCS5Padding is Java's name for what is functionally PKCS7 padding at
 * AES's 16-byte block size, Node's *-cbc ciphers use PKCS7 padding by
 * default, so no special handling is needed there.
 *
 * The IV is a documented fact, not an inference, but there is no genuine
 * plaintext<->ciphertext worked example anywhere in the PDF to validate
 * against (every example uses the same placeholder ciphertext). See
 * docs/OPEN_QUESTIONS.md item 4. IV_MODE is kept switchable in case the
 * documented scheme doesn't match a real encrypted response once we can
 * make one live call.
 */
import { createCipheriv, createDecipheriv, randomFillSync } from "node:crypto";

export type IvMode = "zero-iv" | "key-prefix-iv" | "random-iv-prepended";

/**
 * Single-line switch if the documented zero-IV scheme turns out not to
 * match a real Cleanverse response. See docs/OPEN_QUESTIONS.md item 4.
 */
export const DEFAULT_IV_MODE: IvMode = "zero-iv";

const AES_BLOCK_SIZE_BYTES = 16;

export class InvalidAesKeyError extends Error {
  constructor(byteLength: number) {
    super(
      `Base64-decoded api-key is ${byteLength} bytes; AES requires 16, 24, or 32 ` +
        `(AES-128/192/256). Check CLEANVERSE_API_KEY in .env.`,
    );
    this.name = "InvalidAesKeyError";
  }
}

function algorithmForKey(key: Buffer): "aes-128-cbc" | "aes-192-cbc" | "aes-256-cbc" {
  switch (key.length) {
    case 16:
      return "aes-128-cbc";
    case 24:
      return "aes-192-cbc";
    case 32:
      return "aes-256-cbc";
    default:
      throw new InvalidAesKeyError(key.length);
  }
}

/** Decodes the api-key (Base64) into raw key bytes, asserting a valid AES key size. */
export function decodeApiKey(apiKey: string): Buffer {
  const key = Buffer.from(apiKey, "base64");
  // Validate eagerly so a misconfigured .env fails at decode time, not at
  // the first encrypt/decrypt call.
  algorithmForKey(key);
  return key;
}

function resolveIv(key: Buffer, mode: IvMode, prependedIv?: Buffer): Buffer {
  switch (mode) {
    case "zero-iv":
      return Buffer.alloc(AES_BLOCK_SIZE_BYTES, 0);
    case "key-prefix-iv":
      if (key.length < AES_BLOCK_SIZE_BYTES) {
        throw new Error(
          `key-prefix-iv mode needs a key of at least ${AES_BLOCK_SIZE_BYTES} bytes, got ${key.length}`,
        );
      }
      return key.subarray(0, AES_BLOCK_SIZE_BYTES);
    case "random-iv-prepended":
      if (!prependedIv) {
        throw new Error("random-iv-prepended mode requires an IV to decrypt with");
      }
      return prependedIv;
  }
}

/**
 * Encrypts a JSON-serializable value into the Base64 string Cleanverse
 * expects inside {"data": "<result>"}.
 */
export function encryptBody(
  payload: unknown,
  apiKey: string,
  ivMode: IvMode = DEFAULT_IV_MODE,
): string {
  const key = decodeApiKey(apiKey);
  const algorithm = algorithmForKey(key);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");

  if (ivMode === "random-iv-prepended") {
    const iv = randomIv();
    const cipher = createCipheriv(algorithm, key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([iv, ciphertext]).toString("base64");
  }

  const iv = resolveIv(key, ivMode);
  const cipher = createCipheriv(algorithm, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return ciphertext.toString("base64");
}

/**
 * Decrypts a Cleanverse `data` field (Base64 ciphertext) back into the
 * parsed JSON value.
 */
export function decryptBody<T = unknown>(
  base64Ciphertext: string,
  apiKey: string,
  ivMode: IvMode = DEFAULT_IV_MODE,
): T {
  const key = decodeApiKey(apiKey);
  const algorithm = algorithmForKey(key);
  const raw = Buffer.from(base64Ciphertext, "base64");

  let iv: Buffer;
  let ciphertext: Buffer;
  if (ivMode === "random-iv-prepended") {
    iv = raw.subarray(0, AES_BLOCK_SIZE_BYTES);
    ciphertext = raw.subarray(AES_BLOCK_SIZE_BYTES);
  } else {
    iv = resolveIv(key, ivMode);
    ciphertext = raw;
  }

  const decipher = createDecipheriv(algorithm, key, iv);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}

function randomIv(): Buffer {
  // Only used by the random-iv-prepended mode, which is not the documented
  // default, kept for completeness in case the zero-IV assumption is wrong.
  return Buffer.from(randomFillSync(new Uint8Array(AES_BLOCK_SIZE_BYTES)));
}
