import { useEffect, useRef, useState } from 'react';
import type { Address } from 'viem';
import { publicClient } from '../chain';

const POLL_INTERVAL_MS = 6000;

/** Any connected address's live MON balance, independent of borrow/lend mode, real reads only. The signal useGasFunding watches to decide whether a wallet needs a top-up. */
export function useNativeBalance(address: Address | undefined): bigint | null {
  const [balance, setBalance] = useState<bigint | null>(null);
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (!address) {
      setBalance(null);
      return;
    }

    let cancelled = false;

    async function tick() {
      if (inFlightRef.current || !address) return;
      inFlightRef.current = true;
      try {
        const value = await publicClient.getBalance({ address });
        if (!cancelled) setBalance(value);
      } catch {
        // A transient RPC hiccup should not blank an already-read balance, the next tick retries.
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
  }, [address]);

  return balance;
}
