/**
 * Real borrower onboarding: generates a real Cleanverse A-Pass for a
 * connected wallet, verifies it actually took (query_apass, never trusting
 * generate_apass's own success response alone, see
 * docs/OPEN_QUESTIONS.md's confirmed subTier-must-be-a-string gotcha),
 * submits a real signed on-chain attestation of those facts (so
 * ComplianceRegistry.tierOf reflects the borrower's REAL tier, the value
 * LendingPool.borrow uses for the collateral-ratio calculation regardless
 * of the pool's gate mode, see docs/ARCHITECTURE.md), and funds the
 * address with real testnet gas + rtUSD so it can actually transact.
 *
 * No mock data anywhere in this path: every step is a real Cleanverse UAT
 * sandbox call or a real Monad testnet transaction. If a step fails, the
 * whole provisioning fails loudly rather than returning a partial, faked
 * success.
 */
import { createPublicClient, createWalletClient, http, parseAbi, type Address, type Hex } from "viem";
import { monadTestnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

import { loadConfig } from "../cleanverse/config.js";
import { CleanverseClient } from "../cleanverse/client.js";
import { CleanverseApiError } from "../cleanverse/errors.js";
import type { GenerateApassParams, QueryApassData } from "../cleanverse/types.js";
import { attest } from "../attestor/attest.js";
import type { ApassFactSource } from "../attestor/types.js";
import { createAttestationRelay } from "../attestor/relay.js";
import { attestorAccountFromConfig, loadAttestorConfig } from "../attestor/config.js";
import { buildDomain } from "../attestor/types.js";
import { DEPLOYMENT, CHAIN_ID } from "./deployment.js";

/** Wraps the query_apass result this function already fetched (step 2) as the attestor's fact source, instead of `cleanverseFactSource`'s own fresh query_apass call, real data either way, just without a redundant Cleanverse round trip inside the same request. */
function verifiedFactSource(data: QueryApassData): ApassFactSource {
  return async () => ({
    status: data.status,
    expirationTime: data.expirationTime,
    tier: data.tier,
    subTier: data.subTier,
    countries: data.countries,
  });
}

const ASSET_ABI = parseAbi([
  "function mint(address to, uint256 amount) external",
]);

/** Real testnet gas, matches backend/scripts/reset-demo-position.ts's proven working amount. Only sent if the address is currently below this, so re-provisioning an already-funded address doesn't needlessly drain the deployer. */
const GAS_TOP_UP_THRESHOLD = 3n * 10n ** 17n; // 0.3 MON
const GAS_TOP_UP_AMOUNT = 3n * 10n ** 17n; // 0.3 MON

/** Enough rtUSD to post meaningful collateral and borrow against it at any real ratio band, with headroom left over to experiment (repay, withdraw, borrow more). */
const RTUSD_FUND_AMOUNT = 2_000n * 10n ** 18n;

/** The subTier levels this app actually offers during onboarding, each a real CompliancePolicy band (see contracts/src/CompliancePolicy.sol's RATIO_BANDS). Not the full 1-99 range Cleanverse's API allows, a curated, honest set matching what the borrower surface can show a real ratio for. */
export const ONBOARDING_SUBTIERS = ["0", "20", "50", "80"] as const;
export type OnboardingSubTier = (typeof ONBOARDING_SUBTIERS)[number];

export interface ProvisionResult {
  address: Address;
  customerId: string;
  cvRecordId: string;
  requestedSubTier: OnboardingSubTier;
  verified: {
    tier: string;
    subTier: number;
    status: 1 | 2 | null;
    expirationTime: number | null;
  };
  attestationTxHash: Hex;
  fundedGas: boolean;
  gasTxHash: Hex | null;
  mintTxHash: Hex;
}

export class ProvisionError extends Error {
  constructor(
    message: string,
    public readonly step: string,
  ) {
    super(message);
    this.name = "ProvisionError";
  }
}

/** >= 12 chars, [A-Za-z0-9] only per generate_apass's documented constraint, deterministic per address so re-provisioning the same wallet reuses the same customer record. */
function customerIdFor(address: Address): string {
  return `revoca${address.slice(2).toLowerCase()}`;
}

export async function provisionBorrower(address: Address, requestedSubTier: OnboardingSubTier): Promise<ProvisionResult> {
  const cleanverseConfig = loadConfig();
  const client = new CleanverseClient(cleanverseConfig);
  const rpcUrl = cleanverseConfig.monadTestnetRpc || "https://testnet-rpc.monad.xyz";

  const customerId = customerIdFor(address);
  const expirationTime = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;

  // --- 1. Real generate_apass. If the customer record already exists
  // (a re-provision attempt), Cleanverse rejects the duplicate; that's
  // fine, the existing record is still real, step 2 reads whatever it
  // actually holds rather than assuming this call's success.
  let cvRecordId = "";
  try {
    const result = await client.generateApass({
      customerId,
      subTier: requestedSubTier,
      expirationTime,
      wallet: { address, chain: "monad" },
    } satisfies GenerateApassParams);
    cvRecordId = result.cvRecordId;
  } catch (err) {
    if (!(err instanceof CleanverseApiError)) {
      throw new ProvisionError(describeError(err), "generate_apass");
    }
    // Fall through to query_apass: a real existing record for this
    // customerId/address is a legitimate outcome, not a failure, the
    // verify step below confirms there is something real to work with.
  }

  // --- 2. Never trust generate_apass's own response, verify via the
  // singular query_apass, the authoritative read (see
  // docs/OPEN_QUESTIONS.md item 7 on why the list endpoint isn't used here).
  let verified: QueryApassData;
  try {
    verified = await client.queryApass({ chain: "monad", address });
  } catch (err) {
    throw new ProvisionError(describeError(err), "query_apass");
  }
  if (verified.status !== 1) {
    throw new ProvisionError(
      `A-Pass exists but is not active (status=${verified.status === null ? "unknown" : verified.status}), cannot onboard.`,
      "query_apass",
    );
  }

  // --- 3. Real signed on-chain attestation of exactly what query_apass
  // reported, so ComplianceRegistry.tierOf (the tier source regardless of
  // the pool's gate mode, see docs/ARCHITECTURE.md) reflects this
  // borrower's REAL tier, not the zero-value default.
  const attestorConfig = loadAttestorConfig();
  const attestorAccount = attestorAccountFromConfig(attestorConfig);
  const registryAddress = attestorConfig.registryAddress ?? DEPLOYMENT.registry;

  const publicClient = createPublicClient({ chain: monadTestnet, transport: http(rpcUrl) });
  const relay = createAttestationRelay({ rpcUrl, chain: monadTestnet, registryAddress });
  const domain = buildDomain(CHAIN_ID, registryAddress);
  const factSource = verifiedFactSource(verified);

  let attestationTxHash: Hex;
  try {
    const { attestation, signature } = await attest(
      { factSource, getNextNonce: relay.getNextNonce, now: () => Math.floor(Date.now() / 1000), account: attestorAccount, domain },
      address,
    );
    attestationTxHash = await relay.submit(attestorAccount, attestation, signature);
  } catch (err) {
    throw new ProvisionError(describeError(err), "attestation");
  }

  // --- 4. Fund: real testnet gas (only if needed) + real rtUSD mint, so
  // the borrower can actually post collateral and transact right away.
  const deployerPk = cleanverseConfig.deployerPrivateKey;
  const deployer = privateKeyToAccount(deployerPk);
  const deployerWallet = createWalletClient({ account: deployer, chain: monadTestnet, transport: http(rpcUrl) });

  const fees = await publicClient.estimateFeesPerGas();
  const maxFeePerGas = fees.maxFeePerGas * 2n;
  const maxPriorityFeePerGas = fees.maxPriorityFeePerGas * 2n;

  const balance = await publicClient.getBalance({ address });
  const needsGas = balance < GAS_TOP_UP_THRESHOLD;

  // Both transactions are signed and paid for by the deployer, and the
  // mint doesn't require the recipient to already have gas, so the two
  // are independent: explicit sequential nonces (one signer) let both
  // broadcast back to back, then their confirmations are awaited
  // together instead of one full receipt wait blocking the next send.
  const nonce = await publicClient.getTransactionCount({ address: deployer.address, blockTag: "pending" });

  let gasTxHash: Hex | null = null;
  try {
    if (needsGas) {
      gasTxHash = await deployerWallet.sendTransaction({
        to: address,
        value: GAS_TOP_UP_AMOUNT,
        gas: 100_000n,
        maxFeePerGas,
        maxPriorityFeePerGas,
        nonce,
      });
    }
  } catch (err) {
    throw new ProvisionError(describeError(err), "fund-gas");
  }

  let mintTxHash: Hex;
  try {
    mintTxHash = await deployerWallet.writeContract({
      address: DEPLOYMENT.asset,
      abi: ASSET_ABI,
      functionName: "mint",
      args: [address, RTUSD_FUND_AMOUNT],
      gas: 300_000n,
      maxFeePerGas,
      maxPriorityFeePerGas,
      nonce: needsGas ? nonce + 1 : nonce,
    });
  } catch (err) {
    throw new ProvisionError(describeError(err), "fund-rtusd");
  }

  let fundedGas = false;
  try {
    const waits: Promise<unknown>[] = [publicClient.waitForTransactionReceipt({ hash: mintTxHash, timeout: 180_000 })];
    if (gasTxHash) waits.push(publicClient.waitForTransactionReceipt({ hash: gasTxHash, timeout: 180_000 }));
    await Promise.all(waits);
    fundedGas = gasTxHash !== null;
  } catch (err) {
    throw new ProvisionError(describeError(err), "fund-confirm");
  }

  return {
    address,
    customerId,
    cvRecordId: cvRecordId || verified.cvRecordId,
    requestedSubTier,
    verified: {
      tier: verified.tier,
      subTier: verified.subTier,
      status: verified.status,
      expirationTime: verified.expirationTime,
    },
    attestationTxHash,
    fundedGas,
    gasTxHash,
    mintTxHash,
  };
}

function describeError(err: unknown): string {
  if (err instanceof CleanverseApiError) return `Cleanverse error ${err.code}: ${err.apiMessage}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Parses and validates a request body's subTier field against the curated onboarding set, used by the HTTP handler so invalid input never reaches the sandbox/chain calls. */
export function parseOnboardingSubTier(raw: unknown): OnboardingSubTier {
  if (typeof raw === "string" && (ONBOARDING_SUBTIERS as readonly string[]).includes(raw)) {
    return raw as OnboardingSubTier;
  }
  throw new ProvisionError(`subTier must be one of ${ONBOARDING_SUBTIERS.join(", ")}, got ${JSON.stringify(raw)}`, "validate");
}
