import type { ReactNode } from 'react';
import { Reveal } from './Reveal';

/**
 * One idea, one section. `align` alternates which side the content
 * anchors to as the reader descends, so the page has a visible rhythm
 * rather than a single repeated centered block. The narration is set
 * large and quiet, Fraunces, the way the app's own record headers read;
 * the fact beneath is smaller and precise, the same register the record
 * view uses for real on-chain values.
 *
 * The side opposite the text stays open. Where a section has a real
 * on-chain detail, that detail anchors the space, quiet and precise.
 * Where it doesn't, the space is left as confident whitespace, with
 * only the section's own numeral set very faint, never a drawn shape.
 * The ring lives once, in the header and the hero photograph, not
 * repeated as a vector down the page.
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
  const fillSide = align === 'left' ? 'right' : 'left';
  const numeral = mark.split('.')[0];

  return (
    <section className={`narrative-section narrative-section--${align}`}>
      <div className="narrative-section__grid">
        <div className="narrative-section__inner">
          <Reveal className="narrative-section__mark eyebrow">{mark}</Reveal>
          <Reveal className="narrative-section__narration" delay={0.08}>
            {narration}
          </Reveal>
          <Reveal className="narrative-section__fact" delay={0.22}>
            {fact}
          </Reveal>
        </div>
        <div className={`narrative-section__fill narrative-section__fill--${fillSide}`}>
          {texture ? (
            <Reveal className="narrative-section__texture mono" delay={0.28}>
              {texture}
            </Reveal>
          ) : (
            <div className="narrative-section__numeral" aria-hidden="true">
              {numeral}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
