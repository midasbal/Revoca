import type { ReactNode } from 'react';
import { Reveal } from './Reveal';

/**
 * One idea, one section. `align` alternates which side the content
 * anchors to as the reader descends, so the page has a visible rhythm
 * rather than a single repeated centered block. The narration is set
 * large and quiet, Fraunces, the way the app's own record headers read;
 * the fact beneath is smaller and precise, the same register the record
 * view uses for real on-chain values.
 */
export function NarrativeSection({
  align,
  mark,
  narration,
  fact,
  texture,
}: {
  align: 'left' | 'right';
  mark: string;
  narration: ReactNode;
  fact: ReactNode;
  texture?: ReactNode;
}) {
  return (
    <section className={`narrative-section narrative-section--${align}`}>
      <div className="narrative-section__inner">
        <Reveal className="narrative-section__mark eyebrow">{mark}</Reveal>
        <Reveal className="narrative-section__narration" delay={0.08}>
          {narration}
        </Reveal>
        <Reveal className="narrative-section__fact" delay={0.22}>
          {fact}
        </Reveal>
        {texture && (
          <Reveal className="narrative-section__texture mono" delay={0.32}>
            {texture}
          </Reveal>
        )}
      </div>
    </section>
  );
}
