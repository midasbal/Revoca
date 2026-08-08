/**
 * ONE-OFF FIX. testnet-deploy.ts's persistSecretToEnv had a bug: it treated
 * a pre-existing BLANK "ATTESTOR_PRIVATE_KEY=" placeholder line (from
 * .env.example) as "already configured" and skipped writing the freshly
 * generated key, even though that fresh key was the one actually
 * authorized on-chain via `registry.setAttestor`. Net effect: every
 * deployment this session authorized a real, but never-persisted, attestor
 * address, the private key was generated in memory, used once, then lost.
 *
 * Fixed the helper itself (now fills in blank placeholder lines instead of
 * skipping them) in testnet-deploy.ts and the two generate-apasses
 * scripts. This script recovers the CURRENT deployment: generates a real
 * attestor key, persists it correctly this time, and authorizes it on the
 * CURRENT registry (deployments/testnet.json), a normal owner-only
 * on-chain action, not a redeploy.
 *
 * Run with: npx tsx scripts/testnet-fix-attestor.ts
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createPublicClient, createWalletClient, http, parseAbi, type Address, type Hex } from "viem";
import { monadTestnet } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { config as loadDotenv } from "dotenv";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
loadDotenv({ path: resolve(REPO_ROOT, ".env") });
const ENV_PATH = resolve(REPO_ROOT, ".env");

function persistSecretToEnv(key: string, value: string): void {
  const existing = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  if (new RegExp(`^${key}=.+$`, "m").test(existing)) {
    console.log(`  .env already has a non-empty ${key}, leaving it as-is`);
    return;
  }
  const blankLinePattern = new RegExp(`^${key}=\\s*$`, "m");
  if (blankLinePattern.test(existing)) {
    writeFileSync(ENV_PATH, existing.replace(blankLinePattern, `${key}=${value}`));
    console.log(`  filled in blank ${key} placeholder in .env (value not logged)`);
    return;
  }
  appendFileSync(ENV_PATH, `${existing.endsWith("\n") || existing === "" ? "" : "\n"}${key}=${value}\n`);
  console.log(`  wrote ${key} to .env (value not logged)`);
}

async function main() {
  const deployments = JSON.parse(readFileSync(resolve(REPO_ROOT, "deployments/testnet.json"), "utf8")) as {
    registry: Address;
    attestor: Address;
  };

  const newAttestorPk = generatePrivateKey();
  const newAttestor = privateKeyToAccount(newAttestorPk);
  persistSecretToEnv("ATTESTOR_PRIVATE_KEY", newAttestorPk);
  console.log(`New attestor address: ${newAttestor.address}`);
  console.log(`Previously-authorized-but-unkeyed address (left authorized, harmless): ${deployments.attestor}`);

  const deployerPk = process.env["DEPLOYER_PRIVATE_KEY"] as Hex;
  const rpcUrl = process.env["MONAD_TESTNET_RPC"]!;
  const deployer = privateKeyToAccount(deployerPk);
  const publicClient = createPublicClient({ chain: monadTestnet, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account: deployer, chain: monadTestnet, transport: http(rpcUrl) });

  const REGISTRY_ABI = parseAbi(["function setAttestor(address attestor, bool authorized) external"]);
  const hash = await walletClient.writeContract({
    address: deployments.registry,
    abi: REGISTRY_ABI,
    functionName: "setAttestor",
    args: [newAttestor.address, true],
  });
  console.log(`registry.setAttestor tx: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`status: ${receipt.status}, block ${receipt.blockNumber}`);

  const updated = { ...deployments, attestor: newAttestor.address };
  writeFileSync(resolve(REPO_ROOT, "deployments/testnet.json"), JSON.stringify(updated, null, 2));
  console.log("Updated deployments/testnet.json's attestor field.");
}

main().catch((err) => {
  console.error("testnet-fix-attestor failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
