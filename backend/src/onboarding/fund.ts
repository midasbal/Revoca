/**
 * Standalone funding: real testnet gas + real rtUSD mint for an address
 * that already has standing (e.g. topping up a borrower who's run low
 * mid-session). `provisionBorrower` already does this as its final step
 * for brand-new borrowers; this is the same logic exposed on its own for
 * that reuse case, see backend/api/onboarding/fund.ts. Both draw from the
 * DEPLOYER key, the same account that owns the deployed contracts, an
 * appropriate source for the onboarding path specifically (already
 * gated behind a real Cleanverse verification step, not something
 * anyone can trigger for free).
 *
 * `fundGasOnly` is a different, much lower-trust case: ANY connected
 * wallet, not just one that went through borrower onboarding, needs MON
 * to send any transaction at all, including rtUSD's own client-side mint
 * faucet, and a lender who never touched onboarding has no MON and no
 * way to get either without a first transaction they can't afford to
 * send. Anyone who connects a wallet can trigger this, no verification
 * gate, so it deliberately draws from its OWN small, replenishable
 * FAUCET_PRIVATE_KEY wallet (see faucetConfig.ts), never the deployer
 * key, so a drained or compromised faucet can never touch contract
 * ownership or deployment funds, see backend/api/onboarding/fund-gas.ts.
 */
import { createPublicClient, createWalletClient, http, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { monadTestnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

import { loadConfig } from "../cleanverse/config.js";
import { loadFaucetConfig, faucetAccountFromConfig } from "./faucetConfig.js";
import { DEPLOYMENT } from "./deployment.js";

const ASSET_ABI = parseAbi(["function mint(address to, uint256 amount) external"]);

const GAS_TOP_UP_THRESHOLD = 3n * 10n ** 17n; // 0.3 MON
const GAS_TOP_UP_AMOUNT = 3n * 10n ** 17n;
/** Always left unspent, headroom for the funding transaction's own gas so a low-but-not-empty funder never sends its very last MON and gets stuck unable to pay for its own next tx. */
const FUNDER_MIN_RESERVE = 5n * 10n ** 16n; // 0.05 MON

/** Thrown, never silently swallowed, when the funding wallet (deployer or faucet) genuinely cannot afford to fund right now. The honest failure mode this function is required to have, not a generic RPC error. */
export class DeployerDepletedError extends Error {}

/** Thrown when the dedicated faucet wallet specifically is too low, a distinct, more common case than the deployer running dry, see fundGasOnly. */
export class FaucetDepletedError extends Error {}

function connect() {
  const cleanverseConfig = loadConfig();
  const rpcUrl = cleanverseConfig.monadTestnetRpc || "https://testnet-rpc.monad.xyz";
  const deployer = privateKeyToAccount(cleanverseConfig.deployerPrivateKey);
  const publicClient = createPublicClient({ chain: monadTestnet, transport: http(rpcUrl) });
  const deployerWallet = createWalletClient({ account: deployer, chain: monadTestnet, transport: http(rpcUrl) });
  return { deployer, publicClient, deployerWallet };
}

function connectFaucet() {
  const cleanverseConfig = loadConfig();
  const rpcUrl = cleanverseConfig.monadTestnetRpc || "https://testnet-rpc.monad.xyz";
  const faucet = faucetAccountFromConfig(loadFaucetConfig());
  const publicClient = createPublicClient({ chain: monadTestnet, transport: http(rpcUrl) });
  const faucetWallet = createWalletClient({ account: faucet, chain: monadTestnet, transport: http(rpcUrl) });
  return { faucet, publicClient, faucetWallet };
}

async function assertDeployerCanAfford(publicClient: PublicClient, deployer: Address, need: bigint): Promise<void> {
  const balance = await publicClient.getBalance({ address: deployer });
  if (balance < need + FUNDER_MIN_RESERVE) {
    throw new DeployerDepletedError(
      "The funding wallet is out of testnet gas right now, this is a real, honest limit, not a bug. Ask the operator to refill it.",
    );
  }
}

async function assertFaucetCanAfford(publicClient: PublicClient, faucet: Address, need: bigint): Promise<void> {
  const balance = await publicClient.getBalance({ address: faucet });
  if (balance < need + FUNDER_MIN_RESERVE) {
    throw new FaucetDepletedError(
      "The testnet gas faucet is out of MON right now, this is a real, honest limit, not a bug. Ask the operator to refill it.",
    );
  }
}

export interface FundResult {
  address: Address;
  fundedGas: boolean;
  gasTxHash: Hex | null;
  mintTxHash: Hex;
  amount: string;
}

export async function fundBorrower(address: Address, amountRaw: bigint): Promise<FundResult> {
  const { deployer, publicClient, deployerWallet } = connect();

  const fees = await publicClient.estimateFeesPerGas();
  const maxFeePerGas = fees.maxFeePerGas * 2n;
  const maxPriorityFeePerGas = fees.maxPriorityFeePerGas * 2n;

  let gasTxHash: Hex | null = null;
  let fundedGas = false;
  const balance = await publicClient.getBalance({ address });
  if (balance < GAS_TOP_UP_THRESHOLD) {
    await assertDeployerCanAfford(publicClient, deployer.address, GAS_TOP_UP_AMOUNT);
    gasTxHash = await deployerWallet.sendTransaction({
      to: address,
      value: GAS_TOP_UP_AMOUNT,
      gas: 100_000n,
      maxFeePerGas,
      maxPriorityFeePerGas,
    });
    await publicClient.waitForTransactionReceipt({ hash: gasTxHash, timeout: 180_000 });
    fundedGas = true;
  }

  await assertDeployerCanAfford(publicClient, deployer.address, 0n);
  const mintTxHash = await deployerWallet.writeContract({
    address: DEPLOYMENT.asset,
    abi: ASSET_ABI,
    functionName: "mint",
    args: [address, amountRaw],
    gas: 300_000n,
    maxFeePerGas,
    maxPriorityFeePerGas,
  });
  await publicClient.waitForTransactionReceipt({ hash: mintTxHash, timeout: 180_000 });

  return { address, fundedGas, gasTxHash, mintTxHash, amount: amountRaw.toString() };
}

export interface FundGasResult {
  address: Address;
  funded: boolean;
  gasTxHash: Hex | null;
}

/**
 * Gas only, no mint, for any connected wallet that needs it, not only
 * ones already provisioned as a borrower. A no-op (funded: false) if the
 * address already has enough, so this is always safe to call from the
 * frontend the moment a low balance is observed, never a separate
 * button the user has to find and press. Draws from the dedicated
 * faucet wallet (FAUCET_PRIVATE_KEY), never the deployer, see this
 * file's header.
 */
export async function fundGasOnly(address: Address): Promise<FundGasResult> {
  const { faucet, publicClient, faucetWallet } = connectFaucet();

  const balance = await publicClient.getBalance({ address });
  if (balance >= GAS_TOP_UP_THRESHOLD) {
    return { address, funded: false, gasTxHash: null };
  }

  await assertFaucetCanAfford(publicClient, faucet.address, GAS_TOP_UP_AMOUNT);

  const fees = await publicClient.estimateFeesPerGas();
  const gasTxHash = await faucetWallet.sendTransaction({
    to: address,
    value: GAS_TOP_UP_AMOUNT,
    gas: 100_000n,
    maxFeePerGas: fees.maxFeePerGas * 2n,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas * 2n,
  });
  await publicClient.waitForTransactionReceipt({ hash: gasTxHash, timeout: 180_000 });

  return { address, funded: true, gasTxHash };
}
