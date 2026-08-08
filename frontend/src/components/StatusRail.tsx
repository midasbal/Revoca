import { TickingValue } from './TickingValue';
import type { PositionState } from '../hooks/usePosition';
import { CHAIN_ID } from '../chain';

/**
 * The console's left rail: real, live signs that something is actually
 * watching this record, block height ticking up, when the last read
 * landed, all read straight from usePosition's own poll, no separate
 * request and nothing fabricated to fill the margin.
 */
export function StatusRail({ position, now }: { position: PositionState; now: number }) {
  const ready = position.status === 'ready';
  const secondsSincePoll = ready ? Math.max(0, now - Math.floor(position.data.polledAt / 1000)) : null;

  return (
    <aside className="rail rail--status" aria-label="Live registry status">
      <div className="rail__block">
        <p className="eyebrow rail__label">Network</p>
        <p className="rail__value mono">Monad testnet</p>
        <p className="rail__submeta mono">chain {CHAIN_ID}</p>
      </div>

      <div className="rail__block">
        <p className="eyebrow rail__label">Block height</p>
        {ready ? (
          <TickingValue className="rail__value mono rail__value--lg" value={position.data.blockNumber.toLocaleString('en-US')} />
        ) : (
          <p className="rail__value mono rail__value--lg rail__value--faint">&hellip;</p>
        )}
      </div>

      <div className="rail__block">
        <p className="eyebrow rail__label">Registry</p>
        <p className="rail__watching">
          <span className="rail__watching-dot" aria-hidden="true" />
          Attesting, watching
        </p>
        <p className="rail__submeta mono">
          {secondsSincePoll === null ? 'reading…' : secondsSincePoll <= 1 ? 'polled just now' : `polled ${secondsSincePoll}s ago`}
        </p>
      </div>
    </aside>
  );
}
