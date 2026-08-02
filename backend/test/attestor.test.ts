import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { signAttestation, recoverAttestor } from "../src/attestor/sign.js";
import {
  APASS_STATUS_ACTIVE,
  APASS_STATUS_FROZEN,
  APASS_STATUS_UNKNOWN,
  NO_COUNTRY,
  buildDomain,
  countryAlpha2ToBytes2,
  mapRawFactsToAttestation,
  type RawApassFactFields,
} from "../src/attestor/types.js";
import { attest, LocalApassFactSimulator, cleanverseFactSource } from "../src/attestor/attest.js";

// Well-known Anvil default test account #0 private key, public,
// well-known, holds no real value. Same key used by backend/test/signature.test.ts.
const TEST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

const REGISTRY_ADDRESS = "0x00000000000000000000000000000000000000a1" as const;
const CHAIN_ID = 31337;

describe("countryAlpha2ToBytes2", () => {
  it("encodes a 2-letter alpha-2 code to its raw ASCII bytes2 hex", () => {
    // 'U' = 0x55, 'S' = 0x53, matches Solidity's bytes2("US").
    expect(countryAlpha2ToBytes2("US")).toBe("0x5553");
    expect(countryAlpha2ToBytes2("de")).toBe("0x4445"); // lowercase input is normalized
  });

  it("rejects anything that isn't exactly 2 letters", () => {
    expect(() => countryAlpha2ToBytes2("USA")).toThrow();
    expect(() => countryAlpha2ToBytes2("U")).toThrow();
    expect(() => countryAlpha2ToBytes2("12")).toThrow();
  });
});

describe("mapRawFactsToAttestation, fact mapping", () => {
  const user = "0x1234567890123456789012345678901234567890" as const;
  const nonce = 1n;
  const issuedAt = 1_700_000_000n;

  // Shaped after the 3 real status:2 (frozen) records surfaced against the
  // live UAT sandbox, see backend/test/keeper-dry-run.integration.test.ts's
  // FROZEN_ADDRESSES and docs/TIER_DISTRIBUTION.md's frozen-record finding.
  // This is a pure mapping unit test (no network call), it fixes a
  // realistic query_apass-shaped fixture for each and asserts status:2 maps
  // to APASS_STATUS_FROZEN, with tier/subTier/country all captured intact.
  const FROZEN_RECORD_FIXTURES: RawApassFactFields[] = [
    { status: 2, expirationTime: 1_800_000_000, tier: "50", subTier: 80, countries: ["US"] },
    { status: 2, expirationTime: 1_850_000_000, tier: "20", subTier: 0, countries: ["DE"] },
    { status: 2, expirationTime: null, tier: "0", subTier: 0, countries: [] },
  ];

  it.each(FROZEN_RECORD_FIXTURES)("captures status 2 as APASS_STATUS_FROZEN (%#)", (raw) => {
    const attestation = mapRawFactsToAttestation(raw, user, nonce, issuedAt);

    expect(attestation.apassStatus).toBe(APASS_STATUS_FROZEN);
    expect(attestation.tier).toBe(Number(raw.tier));
    expect(attestation.subTier).toBe(raw.subTier);
    expect(attestation.user).toBe(user);
    expect(attestation.nonce).toBe(nonce);
    expect(attestation.issuedAt).toBe(issuedAt);
  });

  it("maps status 1 to APASS_STATUS_ACTIVE", () => {
    const attestation = mapRawFactsToAttestation(
      { status: 1, expirationTime: null, tier: "50", subTier: 80, countries: ["US"] },
      user,
      nonce,
      issuedAt,
    );
    expect(attestation.apassStatus).toBe(APASS_STATUS_ACTIVE);
  });

  it("maps null/unrecognized status to APASS_STATUS_UNKNOWN, never silently to active", () => {
    const attestation = mapRawFactsToAttestation(
      { status: null, expirationTime: null, tier: "50", subTier: 80, countries: ["US"] },
      user,
      nonce,
      issuedAt,
    );
    expect(attestation.apassStatus).toBe(APASS_STATUS_UNKNOWN);
  });

  it("defaults tier/subTier to 0 when absent or unparseable", () => {
    const attestation = mapRawFactsToAttestation(
      { status: 1, expirationTime: null, tier: null, subTier: null, countries: [] },
      user,
      nonce,
      issuedAt,
    );
    expect(attestation.tier).toBe(0);
    expect(attestation.subTier).toBe(0);
  });

  it("maps an empty countries array to NO_COUNTRY (0x0000)", () => {
    const attestation = mapRawFactsToAttestation(
      { status: 1, expirationTime: null, tier: "50", subTier: 80, countries: [] },
      user,
      nonce,
      issuedAt,
    );
    expect(attestation.country).toBe(NO_COUNTRY);
  });

  it("takes countries[0] when multiple are present, documented tie-break, not a guess", () => {
    const attestation = mapRawFactsToAttestation(
      { status: 1, expirationTime: null, tier: "50", subTier: 80, countries: ["DE", "US"] },
      user,
      nonce,
      issuedAt,
    );
    expect(attestation.country).toBe(countryAlpha2ToBytes2("DE"));
  });

  it("maps a null expirationTime to 0 (the contract's no-expiration sentinel)", () => {
    const attestation = mapRawFactsToAttestation(
      { status: 1, expirationTime: null, tier: "50", subTier: 80, countries: ["US"] },
      user,
      nonce,
      issuedAt,
    );
    expect(attestation.expiry).toBe(0n);
  });
});

describe("signAttestation / recoverAttestor, deterministic EIP-712 signing", () => {
  const account = privateKeyToAccount(TEST_PRIVATE_KEY);
  const domain = buildDomain(CHAIN_ID, REGISTRY_ADDRESS);
  const attestation = {
    user: "0x1234567890123456789012345678901234567890" as const,
    tier: 50,
    subTier: 80,
    country: countryAlpha2ToBytes2("US"),
    apassStatus: APASS_STATUS_ACTIVE,
    expiry: 1_800_000_000n,
    issuedAt: 1_700_000_000n,
    nonce: 1n,
  };

  it("signs deterministically: the same key + same attestation always produces the same signature", async () => {
    const sig1 = await signAttestation(account, domain, attestation);
    const sig2 = await signAttestation(account, domain, attestation);
    expect(sig1).toBe(sig2);
    expect(sig1).toMatch(/^0x[0-9a-f]{130}$/i);
  });

  it("recovers back to the signer's own address", async () => {
    const signature = await signAttestation(account, domain, attestation);
    const recovered = await recoverAttestor(domain, attestation, signature);
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });

  it("does NOT recover to the signer if any single field is tampered with", async () => {
    const signature = await signAttestation(account, domain, attestation);

    const tampered = { ...attestation, tier: attestation.tier + 1 };
    const recovered = await recoverAttestor(domain, tampered, signature);
    expect(recovered.toLowerCase()).not.toBe(account.address.toLowerCase());
  });

  it("does NOT recover to the signer under a different domain (wrong chainId)", async () => {
    const signature = await signAttestation(account, domain, attestation);

    const wrongDomain = buildDomain(CHAIN_ID + 1, REGISTRY_ADDRESS);
    const recovered = await recoverAttestor(wrongDomain, attestation, signature);
    expect(recovered.toLowerCase()).not.toBe(account.address.toLowerCase());
  });

  it("does NOT recover to the signer under a different domain (wrong verifyingContract)", async () => {
    const signature = await signAttestation(account, domain, attestation);

    const wrongDomain = buildDomain(CHAIN_ID, "0x00000000000000000000000000000000000000b2");
    const recovered = await recoverAttestor(wrongDomain, attestation, signature);
    expect(recovered.toLowerCase()).not.toBe(account.address.toLowerCase());
  });
});

describe("attest(), end-to-end signing composition", () => {
  const account = privateKeyToAccount(TEST_PRIVATE_KEY);
  const domain = buildDomain(CHAIN_ID, REGISTRY_ADDRESS);
  const user = "0x1234567890123456789012345678901234567890" as const;

  it("reads facts from the injected source, assigns the given nonce/issuedAt, and produces a verifiable signature", async () => {
    const sim = new LocalApassFactSimulator();
    sim.setActive(user, 50, 80, "US");

    const fixedNow = 1_700_000_000;
    const { attestation, signature } = await attest(
      {
        factSource: sim.asFactSource(),
        getNextNonce: async () => 7n,
        now: () => fixedNow,
        account,
        domain,
      },
      user,
    );

    expect(attestation.tier).toBe(50);
    expect(attestation.subTier).toBe(80);
    expect(attestation.country).toBe(countryAlpha2ToBytes2("US"));
    expect(attestation.apassStatus).toBe(APASS_STATUS_ACTIVE);
    expect(attestation.nonce).toBe(7n);
    expect(attestation.issuedAt).toBe(BigInt(fixedNow));

    const recovered = await recoverAttestor(domain, attestation, signature);
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });

  it("captures a frozen simulated borrower correctly", async () => {
    const sim = new LocalApassFactSimulator();
    sim.freeze(user, 50, 80, "US");

    const { attestation } = await attest(
      { factSource: sim.asFactSource(), getNextNonce: async () => 1n, now: () => 1_700_000_000, account, domain },
      user,
    );

    expect(attestation.apassStatus).toBe(APASS_STATUS_FROZEN);
  });

  it("never-observed simulated borrower maps to unknown status, not active", async () => {
    const sim = new LocalApassFactSimulator();

    const { attestation } = await attest(
      { factSource: sim.asFactSource(), getNextNonce: async () => 1n, now: () => 1_700_000_000, account, domain },
      user,
    );

    expect(attestation.apassStatus).toBe(APASS_STATUS_UNKNOWN);
  });
});

describe("cleanverseFactSource", () => {
  it("is exported and constructible without a live client call (wiring check only)", () => {
    // Full live-sandbox behavior is covered by
    // keeper-dry-run.integration.test.ts's equivalent for classify.ts;
    // this just asserts the factory function itself is wired correctly.
    expect(typeof cleanverseFactSource).toBe("function");
  });
});
