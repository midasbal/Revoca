import type { RatioBand } from '../../hooks/useRatioBands';
import { formatBps } from '../../chain';

/**
 * CompliancePolicy's real ratio-band table (contracts/src/CompliancePolicy.sol),
 * read live, never a hardcoded copy. `activeSubTier` (when given) highlights
 * the exact band a tier/subTier currently earns, so "your standing sets
 * your terms" is visible as a real fact, not asserted in prose.
 */
export function RatioBandsTable({
  bands,
  activeTier,
  activeSubTier,
}: {
  bands: RatioBand[];
  activeTier?: number;
  activeSubTier?: number;
}) {
  return (
    <ul className="band-table">
      {bands.map((band) => {
        const isActive =
          activeTier !== undefined && activeSubTier !== undefined && activeTier === band.minTier && activeSubTier === band.minSubTier;
        return (
          <li key={`${band.minTier}-${band.minSubTier}`} className={`band-table__row${isActive ? ' band-table__row--active' : ''}`}>
            <span className="band-table__tier mono">
              Tier {band.minTier}/{band.minSubTier}
            </span>
            <span className="band-table__ratio">{formatBps(band.ratioBps)}</span>
          </li>
        );
      })}
    </ul>
  );
}
