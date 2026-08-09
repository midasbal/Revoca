import { useEffect } from 'react';
import { reconnect } from 'wagmi/actions';
import { wagmiConfig } from './config';

/**
 * Restores a previously-connected wallet on page reload, wagmi persists
 * which connector was used but doesn't reconnect it automatically. The
 * guard is module-level, not a ref: StrictMode double-invokes this
 * effect in dev (exactly what `npm run dev` runs), and two concurrent
 * `reconnect()` calls against the same injected connector is what
 * actually produced the re-prompt-on-refresh bug, a ref resets per
 * component instance and wouldn't stop StrictMode's second mount from
 * calling it again; this flag persists across both mounts of the same
 * page load.
 */
let attempted = false;

export function useAutoReconnect() {
  useEffect(() => {
    if (attempted) return;
    attempted = true;
    void reconnect(wagmiConfig);
  }, []);
}
