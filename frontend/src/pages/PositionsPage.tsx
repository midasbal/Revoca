import { Link } from 'react-router-dom';
import { Card } from '../components/ui/Card';
import { DEMO_BORROWER } from '../deployment';
import { shortAddress } from '../chain';

/**
 * The full registry listing (every open position, filterable by
 * standing) lands next. For now, a real link to the one live record this
 * environment actually has, not a fabricated table of rows.
 */
export default function PositionsPage() {
  return (
    <div className="page-wrap">
      <Card className="placeholder">
        <p className="eyebrow">Positions</p>
        <h1 className="placeholder__title">The registry, position by position</h1>
        <p className="placeholder__lede">A filterable listing of every open position lands here next. One live record exists in this environment today.</p>
        <Link to={`/positions/${DEMO_BORROWER}`} className="positions-row">
          <span className="positions-row__label mono">{shortAddress(DEMO_BORROWER)}</span>
          <span className="positions-row__meta">Tier 50 / subtier 80 · open record</span>
        </Link>
      </Card>
    </div>
  );
}
