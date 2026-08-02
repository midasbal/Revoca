/**
 * Shared setup for the adversarial scenario suite (backend/test/adversarial/).
 * Spins up a real local anvil chain, deploys the full stack via the same
 * contracts/script/DeployLocal.s.sol used by the dress rehearsal
 * (backend/test/e2e-local-rehearsal.test.ts) and the audit report test, and
 * exposes small, honest helpers for driving real transactions: minting a
 * fresh funded borrower, signing/submitting EIP-712 attestations (including
 * deliberately malformed ones, for the attack scenarios), and printing a
 * demo-narratable "ATTACK -> PROTOCOL -> STATE" trace line.
 *
 * Every scenario in this directory runs against ONE shared deployment
 * (one beforeAll per test file), using a FRESH account per scenario (minted
 * and funded on the fly, MockERC20.mint is unrestricted, see its header) so
 * scenarios never interfere with each other's state, except where a
 * scenario is deliberately sequenced after another (documented inline).
 */
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  parseAbi,
  type Address,
  type Hex,
  type LocalAccount,
  type PublicClient,
} from "viem";
import { foundry } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import {
  buildDomain,
  COMPLIANCE_ATTESTATION_PRIMARY_TYPE,
  COMPLIANCE_ATTESTATION_TYPES,
  type ComplianceAttestation,
  type Eip712Domain,
} from "../../src/attestor/types.js";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const CONTRACTS_DIR = resolve(REPO_ROOT, "../contracts");
export const DEPLOYMENT_PATH = resolve(REPO_ROOT, "../deployments/local.json");

/** Matches contracts/script/DeployLocal.s.sol's constants exactly. */
export const GRACE_PERIOD_SECONDS = 60;
export const MAX_COMPLIANCE_STALENESS_SECONDS = 1800;
export const SEED_TIER = 50;
export const SEED_SUB_TIER = 80;

export interface Deployment {
  asset: Address;
  registry: Address;
  pool: Address;
  guardian: Address;
  policy: Address;
  deployer: Address;
  lender: Address;
  borrower1: Address;
  borrower2: Address;
  borrower3: Address;
  attestor: Address;
  liquidator: Address;
}

export const DEPLOYER_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
export const ATTESTOR_PK = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6" as const;
export const LIQUIDATOR_PK = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba" as const;

export const REGISTRY_ABI = parseAbi([
  "struct ComplianceAttestation { address user; uint16 tier; uint16 subTier; bytes2 country; uint8 apassStatus; uint256 expiry; uint256 issuedAt; uint256 nonce; }",
  "function submitAttestation(ComplianceAttestation attestation, bytes signature) external",
  "function lastNonce(address user) external view returns (uint256)",
  "function domainSeparator() external view returns (bytes32)",
  "function isAttestor(address attestor) external view returns (bool)",
  "function isCompliant(address user) external view returns (bool)",
  "function isFresh(address user) external view returns (bool)",
  "function setAttestor(address attestor, bool authorized) external",
  "error NotAuthorizedAttestor(address signer)",
  "error AttestationStale(uint256 issuedAt, uint256 currentTime)",
  "error AttestationFromFuture(uint256 issuedAt, uint256 currentTime)",
  "error NonceNotIncreasing(uint256 providedNonce, uint256 lastNonce)",
]);

export const POOL_ABI = parseAbi([
  "function postCollateral(uint256 amount) external",
  "function borrow(uint256 amount) external",
  "function repay(uint256 amount) external",
  "function withdrawCollateral(uint256 amount) external",
  "function liquidate(address borrower) external",
  "function positions(address) external view returns (uint256 collateral, uint256 principal, uint256 accruedInterest, uint256 lastAccrualTimestamp)",
  "function currentDebt(address) external view returns (uint256)",
  "function isHealthy(address) external view returns (bool)",
  "error ZeroAmount()",
  "error NotCompliant(address user)",
  "error StaleCompliance(address user)",
  "error TierNotEligible(address user, uint16 tier, uint16 subTier)",
  "error CountryNotEligible(address user, bytes2 country)",
  "error InsufficientCollateralForBorrow(uint256 attemptedDebt, uint256 collateral, uint16 ratioBps)",
  "error PositionHealthy(address borrower)",
  "error NoDebt(address borrower)",
]);

export const GUARDIAN_ABI = parseAbi([
  "function flag(address borrower) external",
  "function reinstate(address borrower) external",
  "function startUnwind(address borrower) external",
  "function completeUnwind(address borrower) external",
  "function positions(address) external view returns (uint8 state, uint8 reason, uint256 flaggedAt, uint256 graceEndsAt, uint256 unwindStartedAt)",
  "error NotEligibleToFlag(address borrower, uint8 currentState)",
  "error PositionNotFlaggable(address borrower)",
  "error NotFlagged(address borrower)",
  "error GracePeriodNotElapsed(address borrower, uint256 graceEndsAt)",
  "error StaleCompliance(address borrower)",
]);

export const POLICY_ABI = parseAbi([
  "function setMinTier(uint16 newValue) external",
  "function minTier() external view returns (uint16)",
]);

export const ERC20_ABI = parseAbi([
  "function mint(address to, uint256 amount) external",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address) external view returns (uint256)",
]);

/** Matches RevocationGuardian.sol's PositionState enum order exactly. */
export const GUARDIAN_STATE = { HEALTHY: 0, FLAGGED: 1, UNWINDING: 2, RESOLVED: 3 } as const;
/** Matches ComplianceRegistry.sol's Reason enum order exactly. */
export const REASON = { NONE: 0, FROZEN: 1, EXPIRED: 2, BLACKLISTED: 3, INELIGIBLE: 4, TIER_DROP: 5 } as const;

/** A concrete, fully-typed wallet client (fixed chain, fixed account), so callers never have to pass `chain`/`account` again at each writeContract call site, see this file's `walletFor`. */
function makeWalletClient(account: LocalAccount, rpcUrl: string) {
  return createWalletClient({ account, chain: foundry, transport: http(rpcUrl) });
}
export type WalletClientFoundry = ReturnType<typeof makeWalletClient>;

export interface Harness {
  rpcUrl: string;
  publicClient: PublicClient;
  testClient: ReturnType<typeof createTestClient>;
  deployment: Deployment;
  domain: Eip712Domain;
  attestorAccount: LocalAccount;
  deployerAccount: LocalAccount;
  liquidatorAccount: LocalAccount;
  walletFor: (account: LocalAccount) => WalletClientFoundry;
  /** Advances anvil's clock and mines one block. Real elapsed time on a real chain, not a mocked clock. */
  advanceTime: (seconds: number) => Promise<void>;
  /** Generates a fresh account, funds it with ETH (setBalance, anvil test action) and MockERC20 (mint, unrestricted, see MockERC20.sol), and approves the pool. Real transactions, real balances. */
  freshFundedBorrower: (assetAmount: bigint) => Promise<LocalAccount>;
  /** Builds and signs a ComplianceAttestation with full control over every field, for both legitimate attestations and the deliberately malformed ones the attack scenarios need. */
  signAttestation: (
    signer: LocalAccount,
    domainOverride: Eip712Domain,
    fields: {
      user: Address;
      tier: number;
      subTier: number;
      country: Hex;
      apassStatus: number;
      expiry: bigint;
      issuedAt: bigint;
      nonce: bigint;
    },
  ) => Promise<Hex>;
  /** Raw submission (does not assume success, callers assert revert/success themselves). */
  submitAttestation: (
    sender: LocalAccount,
    attestation: ComplianceAttestation,
    signature: Hex,
  ) => Promise<Hex>;
  nextNonce: (user: Address) => Promise<bigint>;
  now: () => bigint;
}

const trace: string[] = [];

/** Prints (and records, for the end-of-suite summary) one ATTACK -> PROTOCOL -> STATE demo line. */
export function recordTrace(attack: string, protocolResponse: string, state: string): void {
  const line = `ATTACK: ${attack}\n  PROTOCOL: ${protocolResponse}\n  STATE: ${state}`;
  trace.push(line);
  console.log(line);
}

export function allTraces(): readonly string[] {
  return trace;
}

export function checkToolsAvailable(): boolean {
  try {
    execSync("anvil --version", { stdio: "ignore" });
    execSync("forge --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

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

export async function startHarness(rpcPort: number): Promise<{ harness: Harness; anvilProcess: ChildProcess }> {
  const rpcUrl = `http://127.0.0.1:${rpcPort}`;
  const anvilProcess = spawn("anvil", ["--port", String(rpcPort)], { stdio: "ignore" });
  await waitForRpc(rpcUrl, 15_000);

  execSync(`forge script script/DeployLocal.s.sol --rpc-url ${rpcUrl} --broadcast`, {
    cwd: CONTRACTS_DIR,
    stdio: "pipe",
  });
  if (!existsSync(DEPLOYMENT_PATH)) {
    throw new Error(`Expected ${DEPLOYMENT_PATH} to exist after running DeployLocal.s.sol`);
  }
  const deployment = JSON.parse(readFileSync(DEPLOYMENT_PATH, "utf8")) as Deployment;

  const publicClient = createPublicClient({ transport: http(rpcUrl), cacheTime: 0 });
  const testClient = createTestClient({ chain: foundry, mode: "anvil", transport: http(rpcUrl) });

  const attestorAccount = privateKeyToAccount(ATTESTOR_PK);
  const deployerAccount = privateKeyToAccount(DEPLOYER_PK);
  const liquidatorAccount = privateKeyToAccount(LIQUIDATOR_PK);
  const domain = buildDomain(await publicClient.getChainId(), deployment.registry);

  function walletFor(account: LocalAccount): WalletClientFoundry {
    return makeWalletClient(account, rpcUrl);
  }

  // Tracks the chain's simulated clock, NOT the wall clock. anvil's
  // block.timestamp only moves forward via mined blocks (advanceTime
  // below, or the ~1s/tx it takes for real transactions to mine), it never
  // resyncs to Date.now(). Every scenario in this suite shares ONE anvil
  // instance and several scenarios warp time forward by 30+ minutes, so by
  // the later scenarios the chain's clock is far ahead of the wall clock.
  // Attestation `issuedAt` must track the CHAIN's clock (this is what
  // ComplianceRegistry.sol's staleness/future-skew checks compare against),
  // exactly the same simulatedNow pattern e2e-local-rehearsal.test.ts uses.
  let simulatedNow = BigInt(Math.floor(Date.now() / 1000));

  async function advanceTime(seconds: number): Promise<void> {
    await testClient.increaseTime({ seconds });
    await testClient.mine({ blocks: 1 });
    simulatedNow += BigInt(seconds);
  }

  async function freshFundedBorrower(assetAmount: bigint): Promise<LocalAccount> {
    const account = privateKeyToAccount(generatePrivateKey());
    await testClient.setBalance({ address: account.address, value: 10n ** 20n });

    const wallet = walletFor(account);
    const mintHash = await wallet.writeContract({
      address: deployment.asset,
      abi: ERC20_ABI,
      functionName: "mint",
      args: [account.address, assetAmount],
      account,
      chain: foundry,
    });
    await publicClient.waitForTransactionReceipt({ hash: mintHash });

    const approveHash = await wallet.writeContract({
      address: deployment.asset,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [deployment.pool, assetAmount * 10n],
      account,
      chain: foundry,
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });

    return account;
  }

  async function nextNonce(user: Address): Promise<bigint> {
    const last = await publicClient.readContract({
      address: deployment.registry,
      abi: REGISTRY_ABI,
      functionName: "lastNonce",
      args: [user],
    });
    return last + 1n;
  }

  async function signAttestation(
    signer: LocalAccount,
    domainOverride: Eip712Domain,
    fields: {
      user: Address;
      tier: number;
      subTier: number;
      country: Hex;
      apassStatus: number;
      expiry: bigint;
      issuedAt: bigint;
      nonce: bigint;
    },
  ): Promise<Hex> {
    return signer.signTypedData!({
      domain: domainOverride,
      types: COMPLIANCE_ATTESTATION_TYPES,
      primaryType: COMPLIANCE_ATTESTATION_PRIMARY_TYPE,
      message: fields,
    });
  }

  async function submitAttestation(
    sender: LocalAccount,
    attestation: ComplianceAttestation,
    signature: Hex,
  ): Promise<Hex> {
    const wallet = walletFor(sender);
    const hash = await wallet.writeContract({
      address: deployment.registry,
      abi: REGISTRY_ABI,
      functionName: "submitAttestation",
      args: [attestation, signature],
      account: sender,
      chain: foundry,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  function now(): bigint {
    return simulatedNow;
  }

  const harness: Harness = {
    rpcUrl,
    publicClient,
    testClient,
    deployment,
    domain,
    attestorAccount,
    deployerAccount,
    liquidatorAccount,
    walletFor,
    advanceTime,
    freshFundedBorrower,
    signAttestation,
    submitAttestation,
    nextNonce,
    now,
  };

  return { harness, anvilProcess };
}
