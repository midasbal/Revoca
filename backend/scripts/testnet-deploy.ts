/**
 * REAL Monad testnet deployment of Revoca's full on-chain stack:
 * MockERC20 (lent asset), CompliancePolicy, ComplianceRegistry,
 * HybridComplianceGate (ValidatorGated, pointed at the real Cleanverse CVI
 * Compliance Validator), LendingPool, GraceAndNotifyStrategy (the default
 * IUnwindStrategy, preserving pre-strategy behavior exactly, see
 * docs/ROADMAP.md's refinement backlog), RevocationGuardian.
 *
 * PROVISIONAL DEPLOYMENT, per this session's explicit scoping: the pool
 * will change again once the interest model and pluggable unwind land
 * (docs/ROADMAP.md's refinement backlog), so this is a real, live,
 * transacting deployment used to prove the full loop end to end, not the
 * final registered deployment. Documented as provisional in
 * docs/DESIGN_A_SPIKE.md's window-session findings.
 *
 * CIRCULAR CONSTRUCTOR DEPENDENCY, SOLVED VIA CREATE-NONCE PRECOMPUTATION:
 * HybridComplianceGate needs `validatorPool` (which should be THIS
 * LendingPool's own address, so the validator's registration/rule genuinely
 * governs Revoca's own pool, not an unrelated address) at construction.
 * LendingPool needs `complianceGate_` (the already-deployed
 * HybridComplianceGate) at ITS construction, and `complianceGate` is
 * `immutable`, so it cannot be set after the fact. Standard fix: the
 * deployer's CREATE address is a deterministic function of (deployer,
 * nonce), so this script computes LendingPool's future address from the
 * deployer's nonce BEFORE deploying HybridComplianceGate, deploys
 * HybridComplianceGate with that predicted address as `validatorPool`, then
 * deploys LendingPool next and asserts it landed exactly there.
 *
 * Outputs: deployments/testnet.json (addresses, non-secret). Persists a
 * fresh ATTESTOR_PRIVATE_KEY to .env if one isn't already set (the tier
 * source, ComplianceRegistry, is authorized via `setAttestor`), never
 * printed.
 *
 * Run with: npx tsx scripts/testnet-deploy.ts
 * Requires MONAD_TESTNET_RPC, DEPLOYER_PRIVATE_KEY in .env.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  getContractAddress,
  http,
  type Address,
  type Hex,
} from "viem";
import { monadTestnet } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { config as loadDotenv } from "dotenv";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
loadDotenv({ path: resolve(REPO_ROOT, ".env") });

const VALIDATOR_ADDRESS = "0xaC7e5179C2C7f03f209136886c172eb34F161792" as const satisfies Address;

const GRACE_DURATION_SECONDS = 90n; // short, real wall-clock wait for the live demo
const MAX_COMPLIANCE_STALENESS_SECONDS = 1800n; // 30 min
const INTEREST_RATE_BPS_PER_SECOND = 1n;
const LIQUIDATION_BONUS_BPS = 500n;

function loadArtifact(relPath: string): { abi: unknown; bytecode: { object: Hex } } {
  const p = resolve(REPO_ROOT, "contracts/out", relPath);
  return JSON.parse(readFileSync(p, "utf8"));
}

function persistSecretToEnv(key: string, value: string): void {
  const envPath = resolve(REPO_ROOT, ".env");
  const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  // A bare "KEY=" placeholder line (e.g. from .env.example) has the key
  // NAME present but an EMPTY value, that must be filled in, not skipped,
  // or a freshly generated secret that was already used on-chain/off-chain
  // this run gets silently discarded and lost. Only a line with a real,
  // non-empty value counts as "already configured."
  const nonEmptyMatch = new RegExp(`^${key}=.+$`, "m").exec(existing);
  if (nonEmptyMatch) {
    console.log(`  .env already has a non-empty ${key}, leaving it as-is`);
    return;
  }
  const blankLinePattern = new RegExp(`^${key}=\\s*$`, "m");
  if (blankLinePattern.test(existing)) {
    const updated = existing.replace(blankLinePattern, `${key}=${value}`);
    writeFileSync(envPath, updated);
    console.log(`  filled in blank ${key} placeholder in .env (value not logged)`);
    return;
  }
  appendFileSync(envPath, `${existing.endsWith("\n") || existing === "" ? "" : "\n"}${key}=${value}\n`);
  console.log(`  wrote ${key} to .env (value not logged)`);
}

async function main() {
  const deployerPk = process.env["DEPLOYER_PRIVATE_KEY"] as Hex | undefined;
  const rpcUrl = process.env["MONAD_TESTNET_RPC"];
  if (!deployerPk || !rpcUrl) {
    console.error("DEPLOYER_PRIVATE_KEY or MONAD_TESTNET_RPC not set in .env.");
    process.exitCode = 1;
    return;
  }

  const deployer = privateKeyToAccount(deployerPk);
  const publicClient = createPublicClient({ chain: monadTestnet, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account: deployer, chain: monadTestnet, transport: http(rpcUrl) });

  console.log(`Deployer: ${deployer.address}`);
  const balance = await publicClient.getBalance({ address: deployer.address });
  console.log(`Balance: ${Number(balance) / 1e18} MON`);
  if (balance === 0n) {
    console.error("Deployer balance is 0, cannot deploy.");
    process.exitCode = 1;
    return;
  }

  // Fresh attestor key, authorized on the registry below. Only needs
  // setAttestor authority, never owner/deployer authority, see
  // docs/THREAT_MODEL.md's key-separation note.
  let attestorPk = process.env["ATTESTOR_PRIVATE_KEY"] as Hex | undefined;
  if (!attestorPk) {
    attestorPk = generatePrivateKey();
    persistSecretToEnv("ATTESTOR_PRIVATE_KEY", attestorPk);
  } else {
    console.log("  ATTESTOR_PRIVATE_KEY already set in .env, reusing it");
  }
  const attestor = privateKeyToAccount(attestorPk);
  console.log(`Attestor: ${attestor.address}`);

  const baseNonce = await publicClient.getTransactionCount({ address: deployer.address, blockTag: "pending" });
  console.log(`Base nonce: ${baseNonce}`);

  // Deploy order (CREATE, nonce increments by 1 per deploy):
  //   0: asset (MockERC20)  1: policy (CompliancePolicy)  2: registry (ComplianceRegistry)
  //   3: gate (HybridComplianceGate)  4: pool (LendingPool)
  //   5: strategy (GraceAndNotifyStrategy)  6: guardian (RevocationGuardian)
  const predictedPoolAddress = getContractAddress({ from: deployer.address, nonce: BigInt(baseNonce) + 4n });
  console.log(`Predicted LendingPool address (nonce ${baseNonce + 4}): ${predictedPoolAddress}`);

  async function deploy(label: string, artifactPath: string, args: unknown[]): Promise<Address> {
    const artifact = loadArtifact(artifactPath);
    console.log(`\n=== Deploying ${label} ===`);
    const hash = await walletClient.deployContract({
      abi: artifact.abi as never,
      bytecode: artifact.bytecode.object,
      args: args as never,
    });
    console.log(`  tx: ${hash}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) {
      throw new Error(`${label} deploy receipt has no contractAddress (status ${receipt.status})`);
    }
    console.log(`  address: ${receipt.contractAddress} (status ${receipt.status}, block ${receipt.blockNumber})`);
    return receipt.contractAddress;
  }

  const asset = await deploy("MockERC20 (asset)", "MockERC20.sol/MockERC20.json", ["Revoca Testnet USD", "rtUSD"]);

  const policy = await deploy("CompliancePolicy", "CompliancePolicy.sol/CompliancePolicy.json", [
    deployer.address,
    GRACE_DURATION_SECONDS,
    MAX_COMPLIANCE_STALENESS_SECONDS,
  ]);

  const registry = await deploy("ComplianceRegistry", "ComplianceRegistry.sol/ComplianceRegistry.json", [
    deployer.address,
    policy,
  ]);

  const gate = await deploy("HybridComplianceGate", "HybridComplianceGate.sol/HybridComplianceGate.json", [
    deployer.address,
    VALIDATOR_ADDRESS,
    predictedPoolAddress,
    registry,
    1, // Mode.ValidatorGated
  ]);

  const pool = await deploy("LendingPool", "LendingPool.sol/LendingPool.json", [
    asset,
    gate,
    registry,
    registry,
    policy,
    deployer.address,
    INTEREST_RATE_BPS_PER_SECOND,
    LIQUIDATION_BONUS_BPS,
  ]);

  if (pool.toLowerCase() !== predictedPoolAddress.toLowerCase()) {
    throw new Error(
      `LendingPool landed at ${pool}, not the predicted ${predictedPoolAddress}. HybridComplianceGate's validatorPool is now WRONG, stop and investigate before registering anything.`,
    );
  }
  console.log("  predicted address confirmed exactly, HybridComplianceGate.validatorPool is correct");

  const strategy = await deploy("GraceAndNotifyStrategy", "GraceAndNotifyStrategy.sol/GraceAndNotifyStrategy.json", [
    pool,
  ]);

  const guardian = await deploy("RevocationGuardian", "RevocationGuardian.sol/RevocationGuardian.json", [
    registry,
    pool,
    deployer.address,
    strategy,
  ]);

  // -----------------------------------------------------------------
  // Owner wiring: guardian authority on the pool, attestor authority on
  // the registry.
  // -----------------------------------------------------------------
  const LENDING_POOL_ABI = loadArtifact("LendingPool.sol/LendingPool.json").abi as never;
  const REGISTRY_ABI = loadArtifact("ComplianceRegistry.sol/ComplianceRegistry.json").abi as never;

  console.log("\n=== pool.setGuardian ===");
  let hash = await walletClient.writeContract({
    address: pool,
    abi: LENDING_POOL_ABI,
    functionName: "setGuardian",
    args: [guardian],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  console.log(`  tx: ${hash}`);

  console.log("\n=== registry.setAttestor ===");
  hash = await walletClient.writeContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: "setAttestor",
    args: [attestor.address, true],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  console.log(`  tx: ${hash}`);

  const deployments = {
    network: "monad-testnet",
    chainId: 10143,
    deployedAt: new Date().toISOString(),
    provisional: true,
    provisionalNote:
      "Real, live, transacting deployment used to prove the full loop end to end this session. Will be redeployed again once the pluggable unwind lands for real testnet use, per docs/ROADMAP.md's refinement backlog.",
    validatorAddress: VALIDATOR_ADDRESS,
    deployer: deployer.address,
    attestor: attestor.address,
    asset,
    policy,
    registry,
    gate,
    pool,
    strategy,
    guardian,
  };

  const outPath = resolve(REPO_ROOT, "deployments/testnet.json");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(deployments, null, 2));
  console.log(`\nWrote ${outPath}`);
  console.log("\n=== Summary ===");
  for (const [k, v] of Object.entries(deployments)) {
    console.log(`${k}: ${v}`);
  }
}

main().catch((err) => {
  console.error("testnet-deploy failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
