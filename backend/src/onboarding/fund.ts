/**
 * Standalone funding: real testnet gas + real rtUSD mint for an address
 * that already has standing (e.g. topping up a borrower who's run low
 * mid-session). `provisionBorrower` already does this as its final step
 * for brand-new borrowers; this is the same logic exposed on its own for
 * that reuse case, see docs/BACKEND_CONTRACT.md's `fund` route.
 */
import { createPublicClient, createWalletClient, http, parseAbi, type Address, type Hex } from "viem";
import { monadTestnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

import { loadConfig } from "../cleanverse/config.js";
import { DEPLOYMENT } from "./deployment.js";

const ASSET_ABI = parseAbi(["function mint(address to, uint256 amount) external"]);

const GAS_TOP_UP_THRESHOLD = 3n * 10n ** 17n; // 0.3 MON
const GAS_TOP_UP_AMOUNT = 3n * 10n ** 17n;

export interface FundResult {
  address: Address;
  fundedGas: boolean;
  gasTxHash: Hex | null;
  mintTxHash: Hex;
  amount: string;
}

export async function fundBorrower(address: Address, amountRaw: bigint): Promise<FundResult> {
  const cleanverseConfig = loadConfig();
  const rpcUrl = cleanverseConfig.monadTestnetRpc || "https://testnet-rpc.monad.xyz";
  const deployer = privateKeyToAccount(cleanverseConfig.deployerPrivateKey);

  const publicClient = createPublicClient({ chain: monadTestnet, transport: http(rpcUrl) });
  const deployerWallet = createWalletClient({ account: deployer, chain: monadTestnet, transport: http(rpcUrl) });

  const fees = await publicClient.estimateFeesPerGas();
  const maxFeePerGas = fees.maxFeePerGas * 2n;
  const maxPriorityFeePerGas = fees.maxPriorityFeePerGas * 2n;

  let gasTxHash: Hex | null = null;
  let fundedGas = false;
  const balance = await publicClient.getBalance({ address });
  if (balance < GAS_TOP_UP_THRESHOLD) {
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
