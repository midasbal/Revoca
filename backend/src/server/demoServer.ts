/**
 * Minimal local HTTP server for the frontend's single "record" view
 * (frontend/src/App.tsx). Exists ONLY because the "strike this record"
 * control needs to perform real actions that require secrets
 * (CLEANVERSE_API_KEY/ATTESTOR_PRIVATE_KEY/DEPLOYER_PRIVATE_KEY) which
 * must never reach the browser bundle, see CLAUDE.md's Secrets section.
 * The frontend reads chain state directly via a public RPC client (no
 * secret needed for that), and calls this server only for the two
 * state-changing actions:
 *
 *   POST /api/strike   real Cleanverse update_status (freeze), a real
 *                       post-freeze attestation, then guardian.flag().
 *   POST /api/advance   startUnwind (self-cure, liquidates if the
 *                       self-cure alone doesn't clear the debt), then
 *                       completeUnwind. Only meaningful once grace has
 *                       elapsed, the guardian itself enforces that.
 *
 * No framework, Node's built-in http module is enough for two routes.
 * CORS is scoped to localhost origins only, this never runs anywhere but
 * a developer's machine for this demo.
 *
 * Run with: npx tsx src/server/demoServer.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createPublicClient, createWalletClient, http, parseAbi, type Address, type Hex } from "viem";
import { monadTestnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { config as loadDotenv } from "dotenv";

import { loadConfig } from "../cleanverse/config.js";
import { CleanverseClient } from "../cleanverse/client.js";
import { CleanverseApiError, CleanverseTransportError } from "../cleanverse/errors.js";
import { attest, cleanverseFactSource } from "../attestor/attest.js";
import { createAttestationRelay } from "../attestor/relay.js";
import { buildDomain } from "../attestor/types.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
loadDotenv({ path: resolve(REPO_ROOT, ".env") });

const PORT = Number(process.env["DEMO_SERVER_PORT"] ?? 8787);
const ALLOWED_ORIGINS = new Set(["http://localhost:5173", "http://127.0.0.1:5173"]);

const GUARDIAN_ABI = parseAbi([
  "function flag(address borrower) external",
  "function startUnwind(address borrower) external",
  "function completeUnwind(address borrower) external",
  "function positions(address) external view returns (uint8 state, uint8 reason, uint256 flaggedAt, uint256 graceEndsAt, uint256 unwindStartedAt)",
]);
const POOL_ABI = parseAbi([
  "function currentDebt(address) external view returns (uint256)",
  "function positions(address) external view returns (uint256 collateral, uint256 principal, uint256 accruedInterest, uint256 lastAccrualTimestamp)",
  "function liquidate(address borrower) external",
]);
const ERC20_ABI = parseAbi([
  "function mint(address to, uint256 amount) external",
  "function approve(address spender, uint256 value) external returns (bool)",
]);

function loadDeployments() {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, "deployments/testnet.json"), "utf8")) as {
    asset: Address;
    pool: Address;
    registry: Address;
    guardian: Address;
  };
}

function chainContext() {
  const rpcUrl = process.env["MONAD_TESTNET_RPC"]!;
  const deployerPk = process.env["DEPLOYER_PRIVATE_KEY"] as Hex;
  const attestorPk = process.env["ATTESTOR_PRIVATE_KEY"] as Hex;
  const borrowerPk = process.env["TESTNET_BORROWER_HIGH_PRIVATE_KEY"] as Hex;
  const deployer = privateKeyToAccount(deployerPk);
  const attestor = privateKeyToAccount(attestorPk);
  const borrower = privateKeyToAccount(borrowerPk);
  const publicClient = createPublicClient({ chain: monadTestnet, transport: http(rpcUrl) });
  const deployerWallet = createWalletClient({ account: deployer, chain: monadTestnet, transport: http(rpcUrl) });
  return { rpcUrl, deployer, attestor, borrower, publicClient, deployerWallet };
}

/** This session's demonstrated Monad testnet congestion needs a real fee bump to land reliably, see docs/OPEN_QUESTIONS.md. */
async function bumpedFees(publicClient: ReturnType<typeof createPublicClient>) {
  const fees = await publicClient.estimateFeesPerGas();
  return { maxFeePerGas: fees.maxFeePerGas * 3n, maxPriorityFeePerGas: fees.maxPriorityFeePerGas * 3n };
}

/**
 * viem's waitForTransactionReceipt resolves on ANY mined receipt, reverted
 * or not, it does not throw on a failed status. A real run this session
 * hit exactly this: liquidate() and completeUnwind() both reverted
 * (confirmed via getTransactionReceipt, gasUsed equal to the gas limit
 * passed below, an out-of-gas revert) while this server logged "action
 * completed" because it only checked that a receipt arrived. Every
 * confirmation in this file goes through this wrapper so a revert
 * surfaces as a real error on /api/last-error instead of a false success.
 */
async function waitForSuccess(
  publicClient: ReturnType<typeof createPublicClient>,
  hash: Hex,
  label: string,
) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== "success") {
    throw new Error(`${label} reverted on-chain (tx ${hash})`);
  }
  return receipt;
}

async function handleStrike(): Promise<{ txHashes: string[] }> {
  const ctx = chainContext();
  const deployments = loadDeployments();
  const client = new CleanverseClient(loadConfig());
  const txHashes: string[] = [];

  // Real Cleanverse mutation, real freeze.
  const facts = await client.queryApass({ chain: "monad", address: ctx.borrower.address });
  const freezeResult = await client.updateStatus({
    cvRecordId: facts.cvRecordId,
    status: "2",
    wallet: { chain: "monad", address: ctx.borrower.address },
  });
  txHashes.push(`cleanverse:${freezeResult.txHash}`);

  // Real post-freeze attestation, this is what the guardian actually reacts to.
  const factSource = cleanverseFactSource(client, "monad");
  const chainId = await ctx.publicClient.getChainId();
  const relay = createAttestationRelay({ rpcUrl: ctx.rpcUrl, chain: monadTestnet, registryAddress: deployments.registry });
  const domain = buildDomain(chainId, deployments.registry);
  const { attestation, signature } = await attest(
    { factSource, getNextNonce: relay.getNextNonce, now: () => Math.floor(Date.now() / 1000), account: ctx.attestor, domain },
    ctx.borrower.address,
  );
  const attestHash = await relay.submit(ctx.attestor, attestation, signature);
  txHashes.push(attestHash);
  await waitForSuccess(ctx.publicClient, attestHash, "Post-freeze attestation");

  // Real, permissionless flag().
  const fees = await bumpedFees(ctx.publicClient);
  const flagHash = await ctx.deployerWallet.writeContract({
    address: deployments.guardian,
    abi: GUARDIAN_ABI,
    functionName: "flag",
    args: [ctx.borrower.address],
    gas: 400_000n,
    ...fees,
  });
  txHashes.push(flagHash);
  await waitForSuccess(ctx.publicClient, flagHash, "flag()");

  return { txHashes };
}

async function handleAdvance(): Promise<{ txHashes: string[] }> {
  const ctx = chainContext();
  const deployments = loadDeployments();
  const txHashes: string[] = [];

  const position = await ctx.publicClient.readContract({
    address: deployments.guardian,
    abi: GUARDIAN_ABI,
    functionName: "positions",
    args: [ctx.borrower.address],
  });
  const [state, , , graceEndsAt] = position;

  if (state === 1 /* FLAGGED */) {
    const block = await ctx.publicClient.getBlock();
    if (block.timestamp < graceEndsAt) {
      throw new Error(`Grace period has not elapsed yet (${graceEndsAt - block.timestamp}s remaining).`);
    }

    const fees = await bumpedFees(ctx.publicClient);
    const startHash = await ctx.deployerWallet.writeContract({
      address: deployments.guardian,
      abi: GUARDIAN_ABI,
      functionName: "startUnwind",
      args: [ctx.borrower.address],
      gas: 600_000n,
      ...fees,
    });
    txHashes.push(startHash);
    await waitForSuccess(ctx.publicClient, startHash, "startUnwind()");
  }

  const remainingDebt = await ctx.publicClient.readContract({
    address: deployments.pool,
    abi: POOL_ABI,
    functionName: "currentDebt",
    args: [ctx.borrower.address],
  });

  if (remainingDebt > 0n) {
    // Self-cure alone did not clear it, permissionlessly liquidate,
    // funding the deployer acting as liquidator so the demo can proceed
    // without waiting on a third party, see docs/GRIEFING_ANALYSIS.md for
    // why this branch is a real loss for whoever calls it, not a profit.
    //
    // liquidate() re-reads pos.principal + pos.accruedInterest itself and
    // requires the full then-current debt via safeTransferFrom, real
    // seconds of interest accrue between this read and that call under
    // real Monad congestion (confirmed this session: liquidate() reverted
    // because the exact remainingDebt read here was already stale by the
    // time the tx landed). Minting and approving a buffered amount instead
    // of the exact snapshot avoids re-deriving the live figure right
    // before the call.
    const bufferedDebt = (remainingDebt * 103n) / 100n;
    const deployerBalance = await ctx.publicClient.readContract({
      address: deployments.asset,
      abi: parseAbi(["function balanceOf(address) external view returns (uint256)"]),
      functionName: "balanceOf",
      args: [ctx.deployer.address],
    });
    if (deployerBalance < bufferedDebt) {
      const fees = await bumpedFees(ctx.publicClient);
      const mintHash = await ctx.deployerWallet.writeContract({
        address: deployments.asset,
        abi: ERC20_ABI,
        functionName: "mint",
        args: [ctx.deployer.address, bufferedDebt - deployerBalance],
        gas: 300_000n,
        ...fees,
      });
      txHashes.push(mintHash);
      await waitForSuccess(ctx.publicClient, mintHash, "mint()");
    }

    const fees2 = await bumpedFees(ctx.publicClient);
    const approveHash = await ctx.deployerWallet.writeContract({
      address: deployments.asset,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [deployments.pool, bufferedDebt],
      gas: 300_000n,
      ...fees2,
    });
    txHashes.push(approveHash);
    await waitForSuccess(ctx.publicClient, approveHash, "approve()");

    const fees3 = await bumpedFees(ctx.publicClient);
    const liquidateHash = await ctx.deployerWallet.writeContract({
      address: deployments.pool,
      abi: POOL_ABI,
      functionName: "liquidate",
      args: [ctx.borrower.address],
      gas: 900_000n,
      ...fees3,
    });
    txHashes.push(liquidateHash);
    await waitForSuccess(ctx.publicClient, liquidateHash, "liquidate()");
  }

  const fees4 = await bumpedFees(ctx.publicClient);
  const completeHash = await ctx.deployerWallet.writeContract({
    address: deployments.guardian,
    abi: GUARDIAN_ABI,
    functionName: "completeUnwind",
    args: [ctx.borrower.address],
    gas: 900_000n,
    ...fees4,
  });
  txHashes.push(completeHash);
  await waitForSuccess(ctx.publicClient, completeHash, "completeUnwind()");

  return { txHashes };
}

function withCors(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return false;
  }
  return true;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function describeError(err: unknown): string {
  if (err instanceof CleanverseApiError) return `Cleanverse API error ${err.code}: ${err.apiMessage}`;
  if (err instanceof CleanverseTransportError) return `Cleanverse transport error: ${err.status} ${err.statusText}`;
  return err instanceof Error ? err.message : String(err);
}

/**
 * The real sequences behind /api/strike and /api/advance take several
 * real, sequentially-confirmed Monad testnet transactions each, which
 * this session has seen take minutes under real network congestion, well
 * past what's reasonable to hold a single HTTP request open for. So the
 * handler responds immediately once the action is under way, runs the
 * rest in the background, and the frontend's existing chain polling
 * (usePosition/useLedger) is what actually reflects each step landing,
 * which is a truer match for "the ledger writes itself" than a client
 * sitting on one long request anyway. Errors from the background run are
 * held here for the frontend to pick up via GET /api/last-error, cleared
 * the moment a new action starts.
 */
let lastError: string | null = null;

function runInBackground(action: () => Promise<{ txHashes: string[] }>) {
  lastError = null;
  action()
    .then((result) => console.log("action completed:", result.txHashes))
    .catch((err) => {
      lastError = describeError(err);
      console.error(err);
    });
}

const server = createServer((req, res) => {
  if (!withCors(req, res)) return;

  if (req.method === "GET" && req.url === "/api/last-error") {
    sendJson(res, 200, { error: lastError });
    return;
  }

  if (req.method === "POST" && req.url === "/api/strike") {
    runInBackground(handleStrike);
    sendJson(res, 202, { status: "started" });
    return;
  }

  if (req.method === "POST" && req.url === "/api/advance") {
    runInBackground(handleAdvance);
    sendJson(res, 202, { status: "started" });
    return;
  }

  sendJson(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log(`Demo server listening on http://localhost:${PORT}`);
});
