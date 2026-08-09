import { useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

const EASE_SNAP = [0.62, 0, 0.32, 1.28] as const;
const EASE_CONFIDENT = [0.16, 1, 0.3, 1] as const;

const R = 42;
const RIM_R = 33;
const BREAK_GAP = 0.13;
const SETTLE_GAP = 0.09;
const SETTLE_OFFSET = 1 - BREAK_GAP / 2 - SETTLE_GAP / 2;

export type FillRingVariant = 'intact' | 'breaking' | 'settled';

/**
 * The negative space beside each section's text is never truly empty: a
 * large, quiet echo of the logo/hero ring, low opacity, atmosphere not
 * decoration. Its state answers the section's own place in the story,
 * three deliberately distinct reads rather than one repeated circle:
 *
 *   intact   a whole ring, rim-lit for a little body, nothing amber.
 *   breaking the same ring with one piece genuinely severed, amber, and
 *            physically offset away from where it sat, the way the hero
 *            photograph shows it. Plays once, on scroll into section V.
 *   settled  whole again, but one arc of the ring carries an amber mark
 *            in place, plainly visible, a record of what happened rather
 *            than a hidden seam.
 */
export function NarrativeFillRing({ variant }: { variant: FillRingVariant }) {
  const prefersReduced = useReducedMotion();
  const [played, setPlayed] = useState(variant !== 'breaking');
  const open = variant === 'breaking' && (played || Boolean(prefersReduced));
  const instant = Boolean(prefersReduced) || variant !== 'breaking';

  const ringPathLength = variant === 'breaking' ? (open ? 1 - BREAK_GAP : 1) : 1;

  return (
    <motion.svg
      viewBox="0 0 120 120"
      className={`narrative-fill-ring narrative-fill-ring--${variant}`}
      onViewportEnter={variant === 'breaking' ? () => setPlayed(true) : undefined}
      viewport={{ once: true, amount: 0.5 }}
      animate={prefersReduced ? undefined : { opacity: [0.85, 1, 0.85], scale: [1, 1.02, 1] }}
      transition={{ duration: 6, repeat: Infinity, ease: 'easeInOut' }}
    >
      <circle cx={60} cy={60} r={RIM_R} fill="none" stroke="var(--ink)" strokeWidth={1.5} strokeOpacity={0.4} />

      <motion.circle
        cx={60}
        cy={60}
        r={R}
        fill="none"
        stroke="var(--ink)"
        strokeWidth={5}
        strokeLinecap="round"
        pathLength={1}
        style={{ rotate: -90, transformOrigin: '60px 60px' }}
        initial={false}
        animate={{ pathLength: ringPathLength }}
        transition={{ duration: instant ? 0 : 0.5, ease: EASE_SNAP }}
      />

      {variant !== 'intact' && (
        <motion.g
          initial={false}
          animate={
            variant === 'breaking'
              ? { x: open ? 14 : 0, y: open ? 16 : 0, rotate: open ? 14 : 0 }
              : { x: 0, y: 0, rotate: 0 }
          }
          style={{ transformOrigin: '60px 18px' }}
          transition={{ duration: instant ? 0 : 0.55, delay: instant ? 0 : 0.16, ease: EASE_CONFIDENT }}
        >
          <motion.circle
            cx={60}
            cy={60}
            r={R}
            fill="none"
            stroke="var(--struck)"
            strokeWidth={5}
            strokeLinecap="round"
            pathLength={1}
            style={{
              rotate: -90,
              transformOrigin: '60px 60px',
              pathOffset: variant === 'settled' ? SETTLE_OFFSET : 1 - BREAK_GAP,
            }}
            initial={false}
            animate={{
              pathLength: variant === 'settled' ? SETTLE_GAP : open ? BREAK_GAP : 0,
              opacity: variant === 'settled' ? 0.9 : open ? 1 : 0,
            }}
            transition={{ duration: instant ? 0 : 0.4, delay: instant ? 0 : 0.22, ease: EASE_CONFIDENT }}
          />
        </motion.g>
      )}
    </motion.svg>
  );
}
