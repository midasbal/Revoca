import type { ReactNode } from 'react';
import { Reveal } from './Reveal';
import { NarrativeFillRing, type FillRingVariant } from './NarrativeFillRing';

/**
 * One idea, one section. `align` alternates which side the content
 * anchors to as the reader descends, so the page has a visible rhythm
 * rather than a single repeated centered block. The narration is set
 * large and quiet, Fraunces, the way the app's own record headers read;
 * the fact beneath is smaller and precise, the same register the record
 * view uses for real on-chain values.
 *
 * The side opposite the text is never empty: a large, quiet ring echoes
 * the logo and answers the section's own state (closed, breaking,
 * settled), and where a section has a real on-chain detail, it sits
 * quietly beside the ring rather than in the text column.
 */
export function NarrativeSection({
  align,
  mark,
  leading,
  narration,
  fact,
  texture,
  ringVariant = 'intact',
}: {
  align: 'left' | 'right';
  mark: string;
  leading?: ReactNode;
  narration: ReactNode;
  fact: ReactNode;
  texture?: ReactNode;
  ringVariant?: FillRingVariant;
}) {
  const fillSide = align === 'left' ? 'right' : 'left';
  const d1 = leading ? 0.1 : 0;
  const d2 = leading ? 0.22 : 0.08;
  const d3 = leading ? 0.34 : 0.22;
  const d4 = leading ? 0.44 : 0.32;

  return (
    <section className={`narrative-section narrative-section--${align}`}>
      <div className="narrative-section__grid">
        <div className="narrative-section__inner">
          <Reveal className="narrative-section__mark eyebrow">{mark}</Reveal>
          {leading && (
            <Reveal className="narrative-ring-wrap" delay={d1}>
              {leading}
            </Reveal>
          )}
          <Reveal className="narrative-section__narration" delay={d2}>
            {narration}
          </Reveal>
          <Reveal className="narrative-section__fact" delay={d3}>
            {fact}
          </Reveal>
        </div>
        <div className={`narrative-section__fill narrative-section__fill--${fillSide}`}>
          <div className="narrative-section__fill-ring" aria-hidden="true">
            <NarrativeFillRing variant={ringVariant} />
          </div>
          {texture && (
            <Reveal className="narrative-section__texture mono" delay={d4}>
              {texture}
            </Reveal>
          )}
        </div>
      </div>
    </section>
  );
}
