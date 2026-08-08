import { useEffect } from 'react';
import { reconnect } from 'wagmi/actions';
import { wagmiConfig } from './config';

/** Restores a previously-connected wallet on page reload, wagmi persists which connector was used but doesn't reconnect it automatically. */
export function useAutoReconnect() {
  useEffect(() => {
    void reconnect(wagmiConfig);
  }, []);
}
