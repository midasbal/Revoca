import { useEffect, useRef, useState } from 'react';
import type { Address, Log } from 'viem';
import { DEPLOYMENT, GUARDIAN_ABI, POOL_ABI, fetchLogsChunked, formatAmount, formatBps, publicClient } from '../chain';

export interface LedgerEntry {
  key: string;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: `0x${string}`;
  eventName: string;
  headline: string;
  detail: string;
  timestamp: bigint | null;
}

type DecodedLog = Log & { eventName?: string; args?: Record<string, unknown> };

function describe(log: DecodedLog): { headline: string; detail: string } {
  const a = log.args ?? {};
  switch (log.eventName) {
    case 'CollateralPosted':
      return { headline: 'Collateral posted', detail: `${formatAmount(a.amount as bigint)} rtUSD posted` };
    case 'Borrow':
      return {
        headline: 'Borrowed',
        detail: `${formatAmount(a.amount as bigint)} rtUSD at ${formatBps(a.ratioBps as number)} ratio (tier ${a.tier}/${a.subTier})`,
      };
    case 'Repay':
      return { headline: 'Repaid', detail: `${formatAmount(a.amount as bigint)} rtUSD, ${formatAmount(a.remainingDebt as bigint)} remaining` };
    case 'CollateralWithdrawn':
      return { headline: 'Collateral withdrawn', detail: `${formatAmount(a.amount as bigint)} rtUSD returned` };
    case 'PositionFlagged': {
      const reasons = ['NONE', 'FROZEN', 'EXPIRED', 'BLACKLISTED', 'INELIGIBLE', 'TIER_DROP'];
      return { headline: 'Record flagged', detail: `Reason: ${reasons[a.reason as number] ?? a.reason}` };
    }
    case 'PositionReinstated':
      return { headline: 'Reinstated', detail: 'Standing restored to valid' };
    case 'UnwindStarted':
      return {
        headline: 'Unwind started',
        detail: `Debt ${formatAmount(a.debtAtStart as bigint)} against collateral ${formatAmount(a.collateralAtStart as bigint)}`,
      };
    case 'CollateralAppliedToDebt':
      return {
        headline: 'Self-cure applied',
        detail: `${formatAmount(a.amountApplied as bigint)} applied, ${formatAmount(a.remainingDebt as bigint)} debt remaining`,
      };
    case 'UnwindStep':
      return { headline: `Unwind step: ${a.step}`, detail: `${formatAmount(a.amount as bigint)} applied, ${formatAmount(a.remainingDebt as bigint)} remaining` };
    case 'Liquidate':
      return {
        headline: 'Liquidated',
        detail: `${formatAmount(a.debtRepaid as bigint)} debt repaid, ${formatAmount(a.collateralSeized as bigint)} collateral seized`,
      };
    case 'UnwindCompleted':
      return { headline: 'Resolved', detail: `Residual returned to borrower: ${formatAmount(a.residualCollateral as bigint)} rtUSD` };
    default:
      return { headline: log.eventName ?? 'Event', detail: '' };
  }
}

/**
 * Fetches logs for [fromBlock, toBlock] only, the caller is responsible
 * for remembering how far it's already scanned. Monad's public testnet
 * RPC caps eth_getLogs at 100 blocks AND overall throughput at 15
 * requests/sec (both confirmed for real this session), so rescanning the
 * full history on every poll doesn't scale as the demo runs longer, this
 * hook only ever asks for the blocks it hasn't seen yet.
 */
async function fetchLedgerRange(address: Address, fromBlock: bigint, toBlock: bigint): Promise<LedgerEntry[]> {
  if (fromBlock > toBlock) return [];

  // One chunked scan across both contracts, not two: the RPC's 100-block
  // cap is per request regardless of how many addresses or event
  // signatures are in it, so asking for pool and guardian logs separately
  // was paying for the same block range twice.
  const logs = await fetchLogsChunked({
    address: [DEPLOYMENT.pool, DEPLOYMENT.guardian],
    events: [...POOL_ABI, ...GUARDIAN_ABI].filter((item) => item.type === 'event'),
    fromBlock,
    toBlock,
  });

  const all = logs as DecodedLog[];
  const forBorrower = all.filter((log) => {
    const borrower = (log.args as Record<string, unknown> | undefined)?.borrower;
    return typeof borrower === 'string' && borrower.toLowerCase() === address.toLowerCase();
  });

  if (forBorrower.length === 0) return [];

  forBorrower.sort((a, b) => {
    if (a.blockNumber! !== b.blockNumber!) return a.blockNumber! < b.blockNumber! ? -1 : 1;
    return a.logIndex! - b.logIndex!;
  });

  // Sequential, not Promise.all: a burst of parallel getBlock calls is
  // exactly the kind of spike that tripped the 15/sec cap this session.
  const timestampByBlock = new Map<bigint, bigint>();
  for (const blockNumber of new Set(forBorrower.map((log) => log.blockNumber!))) {
    // eslint-disable-next-line no-await-in-loop -- deliberately sequential, see comment above
    const block = await publicClient.getBlock({ blockNumber });
    timestampByBlock.set(blockNumber, block.timestamp);
  }

  return forBorrower.map((log) => {
    const { headline, detail } = describe(log);
    return {
      key: `${log.transactionHash}-${log.logIndex}`,
      blockNumber: log.blockNumber!,
      logIndex: log.logIndex!,
      transactionHash: log.transactionHash!,
      eventName: log.eventName ?? 'Event',
      headline,
      detail,
      timestamp: timestampByBlock.get(log.blockNumber!) ?? null,
    };
  });
}

const POLL_INTERVAL_MS = 6000;

/**
 * `originBlock` bounds the scan since Monad's public RPC caps eth_getLogs
 * at 100 blocks (see fetchLedgerRange), scanning a pool's entire history
 * on every load isn't practical. Every address this app knows about today
 * has a known origin (see deployment.ts), a future positions registry
 * will need to resolve one per position rather than assume it.
 *
 * `maxBlock`, when given, caps the other end too: instead of scanning
 * forward to the live chain head every load, the scan stops once it
 * passes maxBlock. Only meant for a position that is verifiably closed
 * (see DEMO_LAST_EVENT_BLOCK in deployment.ts), an open position must
 * still poll to the real head or a new event would never be seen.
 */
export function useLedger(address: Address, originBlock: bigint, maxBlock?: bigint): { entries: LedgerEntry[]; loading: boolean } {
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const scannedThrough = useRef(originBlock - 1n);
  const accumulated = useRef<LedgerEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    generation.current += 1;
    const myGeneration = generation.current;
    scannedThrough.current = originBlock - 1n;
    accumulated.current = [];
    setEntries([]);
    setLoading(true);

    async function tick() {
      // The FIRST scan (the full history back to originBlock) can take
      // longer than POLL_INTERVAL_MS on Monad's public RPC. Without this
      // guard, setInterval fires a second tick while the first is still
      // awaiting its own getLogs calls, both read the same not-yet-
      // advanced scannedThrough value, and both append the identical
      // range, real duplicate ledger rows confirmed live this session,
      // not a hypothetical.
      if (inFlight) return;
      // Nothing left to learn once a bounded scan has passed maxBlock,
      // skip the RPC round trip entirely rather than re-fetching an
      // empty range forever.
      if (maxBlock !== undefined && scannedThrough.current >= maxBlock) {
        setLoading(false);
        return;
      }
      inFlight = true;
      try {
        const headBlock = await publicClient.getBlockNumber();
        const toBlock = maxBlock !== undefined && maxBlock < headBlock ? maxBlock : headBlock;
        const fromBlock = scannedThrough.current + 1n;
        const fresh = await fetchLedgerRange(address, fromBlock, toBlock);
        if (cancelled || generation.current !== myGeneration) return;

        scannedThrough.current = toBlock;
        if (fresh.length > 0) {
          accumulated.current = [...accumulated.current, ...fresh];
          setEntries(accumulated.current);
        }
        setLoading(false);
      } catch {
        // A transient RPC hiccup should not blank out an already-populated
        // ledger, or advance the scanned-through marker, the next poll
        // retries the same range.
      } finally {
        inFlight = false;
      }
    }

    void tick();
    const id = window.setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [address, originBlock, maxBlock]);

  return { entries, loading };
}
