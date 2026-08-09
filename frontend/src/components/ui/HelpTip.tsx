import { useId, useState } from 'react';

/**
 * A small "?" affordance for the handful of places a newcomer would
 * genuinely wonder what a term or action means: collateral ratio, rtUSD,
 * a verification level, the like. Hover reveals it on desktop (CSS
 * :hover/:focus-within, no JS needed there); `open` exists so a tap on
 * mobile, which has no hover, toggles the same bubble. Keyboard-reachable
 * as a real button, not a span with an onClick.
 */
export function HelpTip({ label }: { label: string }) {
  const [open, setOpen] = useState(false);
  const bubbleId = useId();

  return (
    <span className="help-tip">
      <button
        type="button"
        className="help-tip__trigger"
        aria-label={`More about this: ${label}`}
        aria-describedby={bubbleId}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        onBlur={() => setOpen(false)}
      >
        ?
      </button>
      <span id={bubbleId} role="tooltip" className={`help-tip__bubble${open ? ' help-tip__bubble--open' : ''}`}>
        {label}
      </span>
    </span>
  );
}
