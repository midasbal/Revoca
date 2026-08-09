export interface CompositionSegment {
  key: string;
  label: string;
  detail: string;
  /** Relative weight, any non-negative number, segments are sized by their share of the total. */
  weight: number;
  tone: 'neutral' | 'grace' | 'struck';
  /** 0..1, only meaningful for `neutral` segments, lets several safe bands stay visually distinct from each other without touching the reserved risk colors. */
  shade?: number;
}

/**
 * A horizontal, proportionally-weighted stacked bar, the shared visual
 * language for both risk views on the pool page: exposure by tier band,
 * and positions currently reacting to a compliance change. Amber
 * (`--grace`/`--struck`) is reserved for segments that ARE the risk
 * signal, everything else stays the calm neutral ink scale, per the
 * design system's one-meaningful-color rule.
 */
export function CompositionBar({ segments, emptyLabel }: { segments: CompositionSegment[]; emptyLabel: string }) {
  const total = segments.reduce((sum, seg) => sum + seg.weight, 0);

  if (total <= 0) {
    return (
      <div className="composition-bar composition-bar--empty">
        <span className="composition-bar__empty-label">{emptyLabel}</span>
      </div>
    );
  }

  return (
    <div className="composition-bar" role="img" aria-label={segments.map((seg) => `${seg.label}: ${seg.detail}`).join(', ')}>
      {segments
        .filter((seg) => seg.weight > 0)
        .map((seg) => (
          <div
            key={seg.key}
            className={`composition-bar__segment composition-bar__segment--${seg.tone}`}
            style={{ flexGrow: seg.weight, opacity: seg.tone === 'neutral' ? (seg.shade ?? 1) : 1 }}
            title={`${seg.label}: ${seg.detail}`}
          />
        ))}
    </div>
  );
}

/** The legend beneath a CompositionBar, same segment list, read as rows rather than area. */
export function CompositionLegend({ segments }: { segments: CompositionSegment[] }) {
  return (
    <ul className="composition-legend">
      {segments.map((seg) => (
        <li key={seg.key} className="composition-legend__row">
          <span
            className={`composition-legend__swatch composition-legend__swatch--${seg.tone}`}
            style={{ opacity: seg.tone === 'neutral' ? (seg.shade ?? 1) : 1 }}
            aria-hidden="true"
          />
          <span className="composition-legend__label">{seg.label}</span>
          <span className="composition-legend__value mono">{seg.detail}</span>
        </li>
      ))}
    </ul>
  );
}
