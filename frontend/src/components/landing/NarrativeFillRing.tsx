import { useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

const GAP = 0.15;
const BASE_R = 42;
const AMBER_R = 50;
const EASE_SNAP = [0.62, 0, 0.32, 1.28] as const;
const EASE_CONFIDENT = [0.16, 1, 0.3, 1] as const;

export type FillRingVariant = 'intact' | 'breaking' | 'settled';

/**
 * The empty side of each alternating section isn't empty: a large, quiet
 * echo of the logo ring, low opacity, atmosphere not decoration. Its state
 * tells the section's own story without another word: closed for standing
 * sections, breaking open (amber, once, on scroll) for the break itself,
 * closed again with a small amber mark at the seam for settlement, standing
 * struck once but resolved.
 */
export function NarrativeFillRing({ variant }: { variant: FillRingVariant }) {
  const prefersReduced = useReducedMotion();
  const [played, setPlayed] = useState(variant !== 'breaking');
  const open = variant === 'breaking' && (played || Boolean(prefersReduced));
  const instant = Boolean(prefersReduced) || variant !== 'breaking';

  return (
    <motion.svg
      viewBox="0 0 120 120"
      className={`narrative-fill-ring narrative-fill-ring--${variant}`}
      onViewportEnter={variant === 'breaking' ? () => setPlayed(true) : undefined}
      viewport={{ once: true, amount: 0.5 }}
      animate={prefersReduced ? undefined : { opacity: [0.85, 1, 0.85], scale: [1, 1.02, 1] }}
      transition={{ duration: 6, repeat: Infinity, ease: 'easeInOut' }}
    >
      <motion.circle
        cx={60}
        cy={60}
        r={BASE_R}
        fill="none"
        stroke="var(--ink)"
        strokeWidth={4}
        strokeLinecap="round"
        pathLength={1}
        style={{ rotate: -90, transformOrigin: '60px 60px' }}
        initial={false}
        animate={{ pathLength: open ? 1 - GAP : 1 }}
        transition={{ duration: instant ? 0 : 0.5, ease: EASE_SNAP }}
      />
      <motion.circle
        cx={60}
        cy={60}
        r={AMBER_R}
        fill="none"
        stroke="var(--struck)"
        strokeWidth={3.5}
        strokeLinecap="round"
        pathLength={1}
        style={{
          rotate: -90,
          transformOrigin: '60px 60px',
          pathOffset: variant === 'settled' ? 0.93 : 1 - GAP,
        }}
        initial={false}
        animate={{
          pathLength: variant === 'settled' ? 0.018 : open ? GAP : 0,
          opacity: variant === 'settled' ? 0.85 : open ? 1 : 0,
        }}
        transition={{ duration: instant ? 0 : 0.45, delay: instant ? 0 : 0.14, ease: EASE_CONFIDENT }}
      />
    </motion.svg>
  );
}
