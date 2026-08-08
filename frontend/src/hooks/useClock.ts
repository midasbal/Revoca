import { useEffect, useState } from 'react';

/** Wall-clock seconds, ticking every second, shared by the record's countdowns and the console rail's "last polled" readout. */
export function useClock(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}
