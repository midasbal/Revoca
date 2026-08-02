/**
 * On-chain relay for signed ComplianceAttestations. `submitAttestation` is
 * PERMISSIONLESS on ComplianceRegistry, trust lives entirely in the
 * ECDSA signature over an authorized attestor's key, not in who sends the
 * transaction (see ComplianceRegistry.sol's header). This module is
 * therefore deliberately split from sign.ts/attest.ts: the account that
 * SIGNS an attestation and the account that RELAYS it on-chain need not be
 * the same key at all.
 *
 * Phase 2b scope note (per the task this module was built for): this stays
 * LOCAL-ANVIL-ONLY. Real Monad testnet relay is Phase 3, see
 * docs/ROADMAP.md. Nothing here hardcodes an RPC URL; callers pass it in
 * explicitly, same pattern as backend/src/keeper/onchain.ts.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Address,
  type Chain,
  type Hex,
  type LocalAccount,
  type PublicClient,
} from "viem";
import type { ComplianceAttestation } from "./types.js";

const REGISTRY_ABI = parseAbi([
  "struct ComplianceAttestation { address user; uint16 tier; uint16 subTier; bytes2 country; uint8 apassStatus; uint256 expiry; uint256 issuedAt; uint256 nonce; }",
  "function submitAttestation(ComplianceAttestation attestation, bytes signature) external",
  "function lastNonce(address user) external view returns (uint256)",
  "function domainSeparator() external view returns (bytes32)",
  "function isAttestor(address attestor) external view returns (bool)",
  "function isCompliant(address user) external view returns (bool)",
]);

export interface AttestationRelayOptions {
  /** JSON-RPC URL, local anvil for this phase (e.g. http://127.0.0.1:8545). See this module's header. */
  rpcUrl: string;
  /** viem Chain config, needed for tx signing/chain-id checks. */
  chain?: Chain;
  registryAddress: Address;
}

export interface AttestationRelay {
  /** The next valid nonce for `user`, `lastNonce(user) + 1`. */
  getNextNonce(user: Address): Promise<bigint>;
  domainSeparator(): Promise<Hex>;
  isAttestor(address: Address): Promise<boolean>;
  isCompliant(user: Address): Promise<boolean>;
  /** Relays a signed attestation on-chain from `sender` (any address, see this module's header). Waits for the receipt before resolving. */
  submit(sender: LocalAccount, attestation: ComplianceAttestation, signature: Hex): Promise<Hex>;
}

export function createAttestationRelay(opts: AttestationRelayOptions): AttestationRelay {
  // cacheTime: 0, same fix as keeper/onchain.ts: without it, viem caches
  // getBlockNumber()/read results briefly, which is wrong for a
  // fast-mining local anvil chain where nonces/state change every block.
  const publicClient: PublicClient = createPublicClient({ transport: http(opts.rpcUrl), cacheTime: 0 });

  async function getNextNonce(user: Address): Promise<bigint> {
    const last = await publicClient.readContract({
      address: opts.registryAddress,
      abi: REGISTRY_ABI,
      functionName: "lastNonce",
      args: [user],
    });
    return last + 1n;
  }

  async function domainSeparator(): Promise<Hex> {
    return publicClient.readContract({
      address: opts.registryAddress,
      abi: REGISTRY_ABI,
      functionName: "domainSeparator",
    });
  }

  async function isAttestor(address: Address): Promise<boolean> {
    return publicClient.readContract({
      address: opts.registryAddress,
      abi: REGISTRY_ABI,
      functionName: "isAttestor",
      args: [address],
    });
  }

  async function isCompliant(user: Address): Promise<boolean> {
    return publicClient.readContract({
      address: opts.registryAddress,
      abi: REGISTRY_ABI,
      functionName: "isCompliant",
      args: [user],
    });
  }

  async function submit(sender: LocalAccount, attestation: ComplianceAttestation, signature: Hex): Promise<Hex> {
    const walletClient = createWalletClient({ account: sender, chain: opts.chain, transport: http(opts.rpcUrl) });
    const hash = await walletClient.writeContract({
      address: opts.registryAddress,
      abi: REGISTRY_ABI,
      functionName: "submitAttestation",
      args: [attestation, signature],
      account: sender,
      chain: opts.chain,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  return { getNextNonce, domainSeparator, isAttestor, isCompliant, submit };
}
