import { motion, useReducedMotion } from 'framer-motion';

/**
 * The page's ground: a faint precision grid behind the record, standing
 * in for the registry's instrument surface rather than empty slate. Two
 * real, restrained signs of life, both tied to real events, nothing
 * fabricated:
 *
 *   - a brief brightening sweep across the grid lines each time a real
 *     poll lands (keyed by `pulseKey`, expected to change on every
 *     successful usePosition tick), read as "the registry just watched
 *     this record again," not a decorative loop.
 *   - when the record is struck, a soft amber vignette settles in at the
 *     edges over a second and a half and stays, an ambient consequence of
 *     the state, not a flash.
 *
 * No gradients on any interactive surface per the brand system, the
 * vignette here is an inset box-shadow (a soft-edged glow, not a color
 * blend) and the pulse is an opacity blip on the existing grid lines,
 * not a new radial light source.
 */
export function AmbientField({ pulseKey, struck }: { pulseKey: string | number | null; struck: boolean }) {
  const prefersReduced = useReducedMotion();

  return (
    <div className={`ambient-field${struck ? ' ambient-field--struck' : ''}`} aria-hidden="true">
      <div className="ambient-field__drift">
        <div className="ambient-field__grid" />
        {!prefersReduced && pulseKey !== null && (
          <motion.div
            key={pulseKey}
            className="ambient-field__sweep"
            initial={{ opacity: 0 }}
            animate={{ opacity: [0, 0.5, 0] }}
            transition={{ duration: 1.2, ease: 'easeOut' }}
          />
        )}
      </div>
      <div className="ambient-field__vignette" />
    </div>
  );
}
