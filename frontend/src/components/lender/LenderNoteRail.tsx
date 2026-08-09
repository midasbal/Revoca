import { Link } from 'react-router-dom';
import { usePositionsRegistry } from '../../hooks/usePositionsRegistry';
import { positionStatus } from '../../positionStatus';

/**
 * The lend surface's right margin. Quiet by default: an honest note on
 * what actually protects a lender's capital, ties straight to the
 * thesis rather than filling space. If a real position in the pool is
 * actually in grace, unwinding, or resolved non-compliant right now,
 * real signal takes over, not a hypothetical, with a link to the pool's
 * full risk composition.
 */
export function LenderNoteRail() {
  const registry = usePositionsRegistry();
  const reacting = registry.entries.filter((entry) => positionStatus(entry).phase === 'struck').length;

  if (reacting > 0) {
    return (
      <aside className="rail rail--standing rail--standing-active" aria-label="Pool compliance status">
        <div className="rail__block">
          <p className="eyebrow rail__label">
            {reacting} position{reacting === 1 ? '' : 's'} reacting
          </p>
          <p className="rail__prose">
            {reacting === 1 ? 'One borrower' : `${reacting} borrowers`} in the pool{' '}
            {reacting === 1 ? 'is' : 'are'} currently in grace or unwinding right now. Self-cure from their own
            collateral is answering the debt first, before liquidation is ever reached, not a hypothetical.
          </p>
        </div>
        <Link className="rail-link" to="/pool">
          See the full composition &rarr;
        </Link>
      </aside>
    );
  }

  return (
    <aside className="rail rail--standing" aria-label="Pool compliance status">
      <div className="rail__block">
        <p className="eyebrow rail__label">What protects your capital</p>
        <p className="rail__prose">
          Every borrower&rsquo;s standing is watched continuously, not checked once at origination. If one lapses,
          self-cure from their own collateral answers the debt first, and only if that falls short does
          liquidation ever reach a lender&rsquo;s deposit.
        </p>
      </div>
      <Link className="rail-link" to="/docs#graduated-unwind">
        How the unwind works &rarr;
      </Link>
    </aside>
  );
}
