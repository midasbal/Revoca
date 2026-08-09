import { useEffect, useRef, useState } from 'react';
import type { Address } from 'viem';
import { DEPLOYMENT, GATE_ABI, GUARDIAN_ABI, POOL_ABI, REGISTRY_ABI, publicClient } from '../chain';
import positionsSeed from '../data/positions-seed.json';

/**
 * There is no on-chain enumeration of "every address that ever borrowed",
 * LendingPool.positions is a plain mapping. Discovering the full set means
 * scanning every CollateralPosted/Borrow event back to the pool's deploy
 * block, and Monad's public testnet RPC caps eth_getLogs at 100 blocks per
 * request (see chain.ts), so a from-genesis scan is genuinely ~3,200
 * chunked requests, tens of minutes, not something a page load should ever
 * do from zero. `positions-seed.json` is a real, honest shortcut: a
 * one-time scan run in this session's own environment (see
 * backend/scripts/scan-all-positions.mjs), shipped as a checkpoint so a
 * fresh browser resumes from wherever that scan reached rather than
 * re-scanning the whole history. The live scanner below always continues
 * from the seed (or a more advanced localStorage checkpoint, whichever is
 * further) forward to the current block, and keeps going in the
 * background, so the registry becomes more complete the longer the tab
 * stays open, never fabricated, always real chain history, just built up
 * progressively where a full scan isn't instant.
 */

interface PositionsSeed {
  pool: string;
  scannedFrom: string;
  scannedTo: string;
  addresses: string[];
}

const seed = positionsSeed as PositionsSeed;
const STORAGE_KEY = `revoca:positions-scan:${DEPLOYMENT.pool.toLowerCase()}`;
const CHUNK_BLOCKS = 90n;
const CHUNK_DELAY_MS = 200;
const REFRESH_INTERVAL_MS = 10_000;

const DISCOVERY_EVENTS_ABI = POOL_ABI.filter(
  (item) => item.type === 'event' && (item.name === 'CollateralPosted' || item.name === 'Borrow'),
);

interface Checkpoint {
  scannedTo: bigint;
  addresses: Set<string>;
}

function loadCheckpoint(): Checkpoint {
  const seedCheckpoint: Checkpoint = { scannedTo: BigInt(seed.scannedTo), addresses: new Set(seed.addresses) };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return seedCheckpoint;
    const parsed = JSON.parse(raw) as { scannedTo: string; addresses: string[] };
    const stored: Checkpoint = { scannedTo: BigInt(parsed.scannedTo), addresses: new Set(parsed.addresses) };
    if (stored.scannedTo < seedCheckpoint.scannedTo) return seedCheckpoint;
    for (const a of seedCheckpoint.addresses) stored.addresses.add(a);
    return stored;
  } catch {
    return seedCheckpoint;
  }
}

function saveCheckpoint(checkpoint: Checkpoint): void {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ scannedTo: checkpoint.scannedTo.toString(), addresses: [...checkpoint.addresses] }),
    );
  } catch {
    // Storage can be full or disabled, the scan just re-runs from the seed next load, not fatal.
  }
}

export interface RegistryEntry {
  address: Address;
  collateral: bigint;
  debt: bigint;
  ratioBps: number;
  tier: number;
  subTier: number;
  compliant: boolean;
  fresh: boolean;
  guardianState: number;
  guardianReason: number;
  graceEndsAt: bigint;
}

export interface PositionsRegistryState {
  /** Every currently-open position (collateral > 0 or debt > 0) among discovered addresses, live data. */
  entries: RegistryEntry[];
  /** True while the background history scan hasn't yet reached the chain head. */
  discovering: boolean;
  scannedBlock: bigint;
  targetBlock: bigint;
  addressesDiscovered: number;
  /** True on the very first live-data fetch, before any entries exist yet. */
  loadingEntries: boolean;
}

async function fetchEntries(addresses: string[]): Promise<RegistryEntry[]> {
  if (addresses.length === 0) return [];

  const calls = addresses.flatMap((address) => [
    { address: DEPLOYMENT.pool, abi: POOL_ABI, functionName: 'positions', args: [address as Address] } as const,
    { address: DEPLOYMENT.pool, abi: POOL_ABI, functionName: 'currentDebt', args: [address as Address] } as const,
    { address: DEPLOYMENT.pool, abi: POOL_ABI, functionName: 'currentRatioBps', args: [address as Address] } as const,
    { address: DEPLOYMENT.registry, abi: REGISTRY_ABI, functionName: 'tierOf', args: [address as Address] } as const,
    { address: DEPLOYMENT.gate, abi: GATE_ABI, functionName: 'isCompliant', args: [address as Address] } as const,
    { address: DEPLOYMENT.gate, abi: GATE_ABI, functionName: 'isFresh', args: [address as Address] } as const,
    { address: DEPLOYMENT.guardian, abi: GUARDIAN_ABI, functionName: 'positions', args: [address as Address] } as const,
  ]);

  const results = await publicClient.multicall({ contracts: calls, allowFailure: false });

  const entries: RegistryEntry[] = [];
  for (let i = 0; i < addresses.length; i++) {
    const base = i * 7;
    const position = results[base] as readonly [bigint, bigint, bigint, bigint];
    const debt = results[base + 1] as bigint;
    const ratioBps = results[base + 2] as number;
    const tierOf = results[base + 3] as readonly [number, number];
    const compliant = results[base + 4] as boolean;
    const fresh = results[base + 5] as boolean;
    const guardianPosition = results[base + 6] as readonly [number, number, bigint, bigint, bigint];

    const collateral = position[0];
    if (collateral === 0n && debt === 0n) continue; // closed position, not part of the live registry

    entries.push({
      address: addresses[i] as Address,
      collateral,
      debt,
      ratioBps,
      tier: tierOf[0],
      subTier: tierOf[1],
      compliant,
      fresh,
      guardianState: guardianPosition[0],
      guardianReason: guardianPosition[1],
      graceEndsAt: guardianPosition[3],
    });
  }
  return entries;
}

/**
 * Discovers every address that has ever interacted with the pool
 * (resuming from the bundled seed / a local checkpoint, never
 * re-scanning from genesis), then keeps their live standing refreshed.
 * The one system-wide view: every real open position, not one record.
 */
export function usePositionsRegistry(): PositionsRegistryState {
  const [entries, setEntries] = useState<RegistryEntry[]>([]);
  const [loadingEntries, setLoadingEntries] = useState(true);
  const [discovering, setDiscovering] = useState(true);
  const [scannedBlock, setScannedBlock] = useState(0n);
  const [targetBlock, setTargetBlock] = useState(0n);
  const [addressesDiscovered, setAddressesDiscovered] = useState(0);

  const checkpointRef = useRef<Checkpoint>(loadCheckpoint());

  useEffect(() => {
    let cancelled = false;

    async function refreshEntries() {
      try {
        const fresh = await fetchEntries([...checkpointRef.current.addresses]);
        if (!cancelled) {
          setEntries(fresh);
          setLoadingEntries(false);
        }
      } catch {
        // A transient RPC hiccup should not blank an already-populated registry, the next tick retries.
        if (!cancelled) setLoadingEntries(false);
      }
    }

    /** One chunk of the forward scan. Re-fetches the chain head each call (not a stale snapshot), so this keeps discovering new positions indefinitely, not just catching up once. */
    async function scanOneChunk(): Promise<boolean> {
      const current = await publicClient.getBlockNumber();
      if (!cancelled) setTargetBlock(current);

      const from = checkpointRef.current.scannedTo + 1n;
      if (from > current) {
        if (!cancelled) setDiscovering(false);
        return false;
      }
      const to = from + CHUNK_BLOCKS - 1n > current ? current : from + CHUNK_BLOCKS - 1n;

      try {
        const logs = await publicClient.getLogs({ address: DEPLOYMENT.pool, events: DISCOVERY_EVENTS_ABI as never, fromBlock: from, toBlock: to });
        for (const log of logs) {
          const borrower = (log as unknown as { args: { borrower?: string } }).args.borrower;
          if (borrower) checkpointRef.current.addresses.add(borrower.toLowerCase());
        }
        checkpointRef.current.scannedTo = to;
        if (!cancelled) {
          setScannedBlock(to);
          setAddressesDiscovered(checkpointRef.current.addresses.size);
          setDiscovering(to < current);
        }
        saveCheckpoint(checkpointRef.current);
      } catch {
        // Transient RPC failure, the next scheduled chunk retries the same range.
      }
      return true;
    }

    async function scanLoop() {
      while (!cancelled) {
        const advanced = await scanOneChunk();
        if (advanced) await refreshEntries();
        // eslint-disable-next-line no-await-in-loop -- deliberate pacing, be polite to a public, rate-limited RPC, see this file's header
        await new Promise((resolve) => window.setTimeout(resolve, advanced ? CHUNK_DELAY_MS : REFRESH_INTERVAL_MS));
      }
    }

    void refreshEntries();
    void scanLoop();

    const refreshId = window.setInterval(() => void refreshEntries(), REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(refreshId);
    };
  }, []);

  return { entries, discovering, scannedBlock, targetBlock, addressesDiscovered, loadingEntries };
}
