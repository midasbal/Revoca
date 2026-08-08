import { useEffect, useRef, useState } from 'react';
import { shortAddress } from '../chain';

/**
 * Console-rail addresses aren't links (unlike the record number and
 * ledger tx hashes, which already navigate to the explorer), they're
 * supporting registry metadata, so the real interaction here is copying
 * the full address rather than leaving the page. Crisp feedback: the
 * label swaps to "Copied" briefly, then reverts, no toast, no modal.
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
    <button type="button" className="rail-address" onClick={() => void handleCopy()}>
      <span className="rail-address__label">{label}</span>
      <span className="rail-address__value mono">{copied ? 'Copied' : shortAddress(address)}</span>
    </button>
  );
}
