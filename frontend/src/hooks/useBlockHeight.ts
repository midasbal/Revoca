import { useEffect, useRef, useState } from 'react';
import { publicClient } from '../chain';

export interface BlockHeightState {
  blockNumber: bigint | null;
  polledAt: number | null;
}

const POLL_INTERVAL_MS = 5000;

/**
 * A single, lightweight global block-height poll, one eth_blockNumber
 * call, shared by the header's live readout and the ground's ambient
 * pulse. Deliberately separate from usePosition's own per-record poll
 * (which already gets a block via its multicall Promise.all), this one
 * has no page-specific dependency, it's the same signal any page in the
 * app can show, real data, not decoration.
 */
export function useBlockHeight(): BlockHeightState {
  const [state, setState] = useState<BlockHeightState>({ blockNumber: null, polledAt: null });
  const inFlightRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function tick() {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        const blockNumber = await publicClient.getBlockNumber();
        if (!cancelled) setState({ blockNumber, polledAt: Date.now() });
      } catch {
        // A transient RPC hiccup should not blank out an already-shown block height, the next poll retries.
      } finally {
        inFlightRef.current = false;
      }
    }

    void tick();
    const id = window.setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  return state;
}
