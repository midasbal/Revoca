import { Link } from 'react-router-dom';
import type { Address } from 'viem';
import { GuardianReason, GuardianState } from '../../chain';
import type { BorrowerSnapshot } from '../../hooks/useBorrowerStanding';

/**
 * The borrow surface's right margin. Quiet by default: an honest note on
 * what actually happens if a standing lapses, ties straight to the
 * thesis rather than filling space. If this position is actually in
 * grace, unwinding, or resolved non-compliant right now, real signal
 * takes over, not a hypothetical, with a link to the full record.
 */
export function StandingNoteRail({ standing, address, now }: { standing: BorrowerSnapshot; address: Address; now: number }) {
  const inGrace = standing.guardianState === GuardianState.FLAGGED;
  const unwinding = standing.guardianState === GuardianState.UNWINDING;
  const resolvedNonCompliant = standing.guardianState === GuardianState.RESOLVED && !standing.compliant;
  const active = inGrace || unwinding || resolvedNonCompliant;
  const graceRemaining = inGrace ? Number(standing.graceEndsAt) - now : null;

  if (active) {
    return (
      <aside className="rail rail--standing rail--standing-active" aria-label="Standing status">
        <div className="rail__block">
          <p className="eyebrow rail__label">{inGrace ? 'In grace' : unwinding ? 'Unwinding' : 'Struck'}</p>
          <p className="rail__prose">
            {inGrace ? (
              <>
                Your standing lapsed, reason <span className="mono">{GuardianReason[standing.guardianReason] ?? 'UNKNOWN'}</span>.
                {graceRemaining !== null && graceRemaining > 0 ? (
                  <>
                    {' '}
                    Grace ends in <span className="mono">{graceRemaining}s</span>, reinstated in full if it returns before then.
                  </>
                ) : (
                  ' Grace has ended.'
                )}
              </>
            ) : unwinding ? (
              <>Grace has passed. Your own collateral is answering the debt first, before anything else.</>
            ) : (
              <>This position was unwound while non-compliant. Any residual collateral is still yours to withdraw.</>
            )}
          </p>
        </div>
        <Link className="rail-link" to={`/positions/${address}`}>
          View the full record &rarr;
        </Link>
      </aside>
    );
  }

  return (
    <aside className="rail rail--standing" aria-label="Standing status">
      <div className="rail__block">
        <p className="eyebrow rail__label">If your standing lapses</p>
        <p className="rail__prose">
          A freeze, an expiry, or a tier drop does not seize your collateral outright. Your own collateral answers
          the debt first, a grace period follows, and only what remains truly owed is ever called in.
        </p>
      </div>
      <Link className="rail-link" to="/docs#graduated-unwind">
        How the unwind works &rarr;
      </Link>
    </aside>
  );
}
