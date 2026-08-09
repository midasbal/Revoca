import { useEffect, useRef, useState } from 'react';
import { explorerAddressUrl, shortAddress } from '../chain';

/**
 * The primary interaction stays copying the full address, not leaving the
 * page, crisp feedback: the label swaps to "Copied" briefly, then reverts,
 * no toast, no modal. A small explorer link sits alongside it, real on-
 * chain proof one click away for a judge, without turning the whole row
 * into a navigation link (which would fight the copy interaction).
 */
export function CopyableAddress({ label, address }: { label: string; address: string }) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timeoutRef.current), []);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard access can be denied by the browser, the address is still visible to select manually.
    }
  }

  return (
    <span className="rail-address">
      <button type="button" className="rail-address__copy" onClick={() => void handleCopy()}>
        <span className="rail-address__label">{label}</span>
        <span className="rail-address__value mono">{copied ? 'Copied' : shortAddress(address)}</span>
      </button>
      <a className="rail-address__explorer" href={explorerAddressUrl(address as `0x${string}`)} target="_blank" rel="noreferrer" aria-label={`View ${label} on Monad testnet explorer`}>
        ↗
      </a>
    </span>
  );
}
