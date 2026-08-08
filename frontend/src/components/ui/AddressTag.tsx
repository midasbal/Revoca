import { useEffect, useRef, useState } from 'react';
import { shortAddress } from '../../chain';

/**
 * A compact, copy-on-click address chip, the connected-account display in
 * the header, and anywhere else a bare address needs to sit inline rather
 * than as a labeled rail row (that's CopyableAddress). Same crisp
 * feedback pattern: the value itself swaps to "Copied" briefly.
 */
export function AddressTag({ address, className }: { address: string; className?: string }) {
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
    <button type="button" className={['address-tag', 'mono', className].filter(Boolean).join(' ')} onClick={() => void handleCopy()}>
      {copied ? 'Copied' : shortAddress(address)}
    </button>
  );
}
