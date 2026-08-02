/**
 * THE HEADLINE PROOF (Phase 2b, Part 4): an EIP-712 ComplianceAttestation
 * signed OFF-CHAIN with viem is ACCEPTED by ComplianceRegistry.sol deployed
 * on a real (local) chain, with the contract's own `_hashTypedDataV4`
 * recovering the same signer viem intended. This is the whole point of
 * Design B's attestor path: the byte-for-byte EIP-712 hash (domain
 * separator + struct hash + digest) must match EXACTLY between viem's
 * TypeScript implementation and Solidity's, or nothing here works at all.
 *
 * Two independent checks, not one:
 *   1. The domain separator this test computes BY HAND (its own
 *      keccak256/abi-encode, not delegated to viem's typed-data helpers or
 *      to the contract) is byte-for-byte identical to the deployed
 *      registry's own `domainSeparator()` view. This isolates the domain
 *      half of the hash from anything submitAttestation's success/failure
 *      could hide.
 *   2. A full attestation, built and signed via the REAL production
 *      modules (backend/src/attestor/attest.ts, sign.ts, relay.ts, not a
 *      hand-rolled parallel implementation), is relayed to the deployed
 *      registry and ACCEPTED: the contract recovers the same attestor
 *      address this test's own (independent) `recoverTypedDataAddress`
 *      call recovers, and the stored facts match exactly.
 *
 * Uses contracts/script/DeployLocal.s.sol for the deployment (real deploy
 * txs on anvil), see that script's header for why it authorizes
 * ATTESTOR_PK as the registry's attestor. Skipped automatically if
 * anvil/forge aren't on PATH, same convention as
 * e2e-local-rehearsal.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, encodeAbiParameters, http, keccak256, toHex, type Address } from "viem";
import { foundry } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

import { attest, LocalApassFactSimulator } from "../src/attestor/attest.js";
import { buildDomain, countryAlpha2ToBytes2, APASS_STATUS_ACTIVE } from "../src/attestor/types.js";
import { recoverAttestor } from "../src/attestor/sign.js";
import { createAttestationRelay } from "../src/attestor/relay.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CONTRACTS_DIR = resolve(REPO_ROOT, "contracts");
const DEPLOYMENT_PATH = resolve(REPO_ROOT, "deployments/local.json");
const RPC_PORT = 8556; // distinct from e2e-local-rehearsal.test.ts's 8555, so both can run concurrently
const RPC_URL = `http://127.0.0.1:${RPC_PORT}`;

// Matches contracts/script/DeployLocal.s.sol's ATTESTOR_PK exactly, one of
// anvil's public, well-known default dev-account keys (mnemonic "test test
// test ... junk"), holds no real value.
const ATTESTOR_PK = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6" as const;
// A fresh, never-before-attested address, distinct from DeployLocal.s.sol's
// seeded borrowers, so this test's nonce starts at 1 with no interference.
const FRESH_USER = "0x0000000000000000000000000000000000c0ffee" as const satisfies Address;

interface Deployment {
  registry: Address;
}

let anvilProcess: ChildProcess | undefined;
let deployment: Deployment;

async function waitForRpc(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`anvil did not become ready at ${url} within ${timeoutMs}ms`);
}

function checkToolsAvailable(): boolean {
  try {
    execSync("anvil --version", { stdio: "ignore" });
    execSync("forge --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Computes an EIP-712 domain separator BY HAND, keccak256 over the
 * abi-encoded (typehash, name-hash, version-hash, chainId,
 * verifyingContract) tuple, exactly per the EIP-712 spec and exactly what
 * OpenZeppelin's EIP712._domainSeparatorV4() computes internally. This does
 * NOT call viem's `hashTypedData`/`signTypedData` helpers and does NOT ask
 * the contract for its own domainSeparator(), it is an independent
 * from-the-spec reimplementation, so equality with the deployed registry's
 * `domainSeparator()` genuinely proves the two sides agree byte-for-byte,
 * not that they both delegated to the same helper.
 */
function computeDomainSeparatorByHand(name: string, version: string, chainId: number, verifyingContract: Address): `0x${string}` {
  const EIP712_DOMAIN_TYPEHASH = keccak256(
    toHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
  );
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [EIP712_DOMAIN_TYPEHASH, keccak256(toHex(name)), keccak256(toHex(version)), BigInt(chainId), verifyingContract],
    ),
  );
}

describe.runIf(checkToolsAvailable())("EIP-712 off-chain sign == on-chain verify (anvil cross-check)", () => {
  beforeAll(async () => {
    anvilProcess = spawn("anvil", ["--port", String(RPC_PORT)], { stdio: "ignore" });
    await waitForRpc(RPC_URL, 15_000);

    execSync(`forge script script/DeployLocal.s.sol --rpc-url ${RPC_URL} --broadcast`, {
      cwd: CONTRACTS_DIR,
      stdio: "pipe",
    });

    if (!existsSync(DEPLOYMENT_PATH)) {
      throw new Error(`Expected ${DEPLOYMENT_PATH} to exist after running DeployLocal.s.sol`);
    }
    deployment = JSON.parse(readFileSync(DEPLOYMENT_PATH, "utf8")) as Deployment;
  }, 60_000);

  afterAll(() => {
    anvilProcess?.kill();
  });

  it(
    "byte-for-byte domain separator: this test's hand-rolled computation matches the deployed registry's own domainSeparator()",
    async () => {
      const publicClient = createPublicClient({ transport: http(RPC_URL), cacheTime: 0 });
      const chainId = await publicClient.getChainId();
      const relay = createAttestationRelay({ rpcUrl: RPC_URL, chain: foundry, registryAddress: deployment.registry });

      const handComputed = computeDomainSeparatorByHand("Revoca", "1", chainId, deployment.registry);
      const onChain = await relay.domainSeparator();

      expect(handComputed).toBe(onChain);
    },
    30_000,
  );

  it(
    "an attestation signed off-chain with viem is accepted on-chain, with the contract recovering the SAME signer this test recovers independently",
    async () => {
      const publicClient = createPublicClient({ transport: http(RPC_URL), cacheTime: 0 });
      const chainId = await publicClient.getChainId();
      const relay = createAttestationRelay({ rpcUrl: RPC_URL, chain: foundry, registryAddress: deployment.registry });
      const attestorAccount = privateKeyToAccount(ATTESTOR_PK);
      const domain = buildDomain(chainId, deployment.registry);

      // Sanity: this key really is authorized on the deployed registry
      // (set by DeployLocal.s.sol's setAttestor call), if this fails, the
      // rest of this test would be meaningless.
      expect(await relay.isAttestor(attestorAccount.address)).toBe(true);

      const sim = new LocalApassFactSimulator();
      const fixedNow = Math.floor(Date.now() / 1000);
      sim.setActive(FRESH_USER, 50, 80, "US");

      const { attestation, signature } = await attest(
        {
          factSource: sim.asFactSource(),
          getNextNonce: (user) => relay.getNextNonce(user),
          now: () => fixedNow,
          account: attestorAccount,
          domain,
        },
        FRESH_USER,
      );

      // Independent, purely off-chain recovery, no contract call at all.
      const offChainRecovered = await recoverAttestor(domain, attestation, signature);
      expect(offChainRecovered.toLowerCase()).toBe(attestorAccount.address.toLowerCase());

      // Relay it (any sender may relay, see relay.ts's header) and assert
      // the ON-CHAIN verification path (ComplianceRegistry.sol's
      // `_hashTypedDataV4` + `ECDSA.recover`) accepts it, a signature
      // recovering to the WRONG signer would revert with
      // NotAuthorizedAttestor instead of succeeding.
      const txHash = await relay.submit(attestorAccount, attestation, signature);
      expect(txHash).toMatch(/^0x[0-9a-f]{64}$/i);

      // And that the facts landed EXACTLY as signed, proves the struct
      // decoded on-chain matches what was encoded off-chain, not just that
      // recovery happened to succeed.
      const REGISTRY_ABI_FOR_READBACK = [
        {
          type: "function",
          name: "attestationOf",
          stateMutability: "view",
          inputs: [{ name: "user", type: "address" }],
          outputs: [
            { name: "tier", type: "uint16" },
            { name: "subTier", type: "uint16" },
            { name: "country", type: "bytes2" },
            { name: "apassStatus", type: "uint8" },
            { name: "expiry", type: "uint256" },
            { name: "issuedAt", type: "uint256" },
          ],
        },
        {
          type: "function",
          name: "isCompliant",
          stateMutability: "view",
          inputs: [{ name: "user", type: "address" }],
          outputs: [{ type: "bool" }],
        },
      ] as const;

      const [tier, subTier, country, apassStatus, expiry, issuedAt] = await publicClient.readContract({
        address: deployment.registry,
        abi: REGISTRY_ABI_FOR_READBACK,
        functionName: "attestationOf",
        args: [FRESH_USER],
      });

      expect(tier).toBe(attestation.tier);
      expect(subTier).toBe(attestation.subTier);
      expect(country).toBe(countryAlpha2ToBytes2("US"));
      expect(country).toBe(attestation.country);
      expect(apassStatus).toBe(APASS_STATUS_ACTIVE);
      expect(expiry).toBe(attestation.expiry);
      expect(issuedAt).toBe(attestation.issuedAt);
      expect(issuedAt).toBe(BigInt(fixedNow));

      const isCompliant = await publicClient.readContract({
        address: deployment.registry,
        abi: REGISTRY_ABI_FOR_READBACK,
        functionName: "isCompliant",
        args: [FRESH_USER],
      });
      expect(isCompliant).toBe(true); // default policy has no tier/country restriction, active + unexpired is enough
    },
    30_000,
  );

  it(
    "a tampered attestation (same signature, different facts) is REJECTED on-chain, the digest no longer matches",
    async () => {
      const chainId = await createPublicClient({ transport: http(RPC_URL), cacheTime: 0 }).getChainId();
      const relay = createAttestationRelay({ rpcUrl: RPC_URL, chain: foundry, registryAddress: deployment.registry });
      const attestorAccount = privateKeyToAccount(ATTESTOR_PK);
      const domain = buildDomain(chainId, deployment.registry);

      const sim = new LocalApassFactSimulator();
      const otherUser = "0x0000000000000000000000000000000000babe01" as const satisfies Address;
      sim.setActive(otherUser, 50, 80, "US");

      const { attestation, signature } = await attest(
        {
          factSource: sim.asFactSource(),
          getNextNonce: (user) => relay.getNextNonce(user),
          now: () => Math.floor(Date.now() / 1000),
          account: attestorAccount,
          domain,
        },
        otherUser,
      );

      const tampered = { ...attestation, tier: attestation.tier + 1 };

      await expect(relay.submit(attestorAccount, tampered, signature)).rejects.toThrow();
    },
    30_000,
  );
});
