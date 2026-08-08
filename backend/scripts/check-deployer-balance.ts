/**
 * Quick real balance check for DEPLOYER_PRIVATE_KEY on Monad testnet, used
 * to confirm there's enough MON before the testnet-lifecycle deployment.
 * Read-only, no transaction sent.
 */
import { createPublicClient, http } from "viem";
import { monadTestnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
loadDotenv({ path: resolve(REPO_ROOT, ".env") });

async function main() {
  const pk = process.env["DEPLOYER_PRIVATE_KEY"] as `0x${string}` | undefined;
  const rpcUrl = process.env["MONAD_TESTNET_RPC"];
  if (!pk || !rpcUrl) {
    console.error("DEPLOYER_PRIVATE_KEY or MONAD_TESTNET_RPC not set.");
    process.exitCode = 1;
    return;
  }
  const account = privateKeyToAccount(pk);
  const client = createPublicClient({ chain: monadTestnet, transport: http(rpcUrl) });
  const bal = await client.getBalance({ address: account.address });
  const chainId = await client.getChainId();
  console.log("deployer:", account.address);
  console.log("chainId:", chainId);
  console.log("balance (wei):", bal.toString());
  console.log("balance (MON):", Number(bal) / 1e18);
}

main().catch((err) => {
  console.error("check-deployer-balance failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
