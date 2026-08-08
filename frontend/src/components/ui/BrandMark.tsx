import { motion, useReducedMotion } from 'framer-motion';

const GAP = 0.15;
const BASE_R = 42;
const AMBER_R = 50;

/**
 * The actual mark, everywhere it appears in chrome (header, footer,
 * favicon source): a closed ink ring with one segment permanently broken
 * and answered by the brand's amber, exactly the logo's own geometry
 * (revoca-logo.jpeg), not a placeholder circle. Unlike RingMark, which
 * animates open on a live strike, this is always in its resting broken
 * state, it's the identity mark, not a specific record's live standing.
 * A very slow breathe signals presence without pretending to be live data.
 */
export function BrandMark({ className }: { className?: string }) {
  const prefersReduced = useReducedMotion();

  return (
    <motion.svg
      viewBox="0 0 120 120"
      className={['brand-mark', className].filter(Boolean).join(' ')}
      role="img"
      aria-label="Revoca"
      animate={prefersReduced ? undefined : { opacity: [0.94, 1, 0.94] }}
      transition={{ duration: 4.4, repeat: Infinity, ease: 'easeInOut' }}
      style={{ transformOrigin: '60px 60px' }}
    >
      <circle
        cx={60}
        cy={60}
        r={BASE_R}
        fill="none"
        stroke="var(--ink)"
        strokeWidth={7}
        strokeLinecap="round"
        pathLength={1}
        strokeDasharray={`${1 - GAP} ${GAP}`}
        transform="rotate(-90 60 60)"
      />
      <circle
        cx={60}
        cy={60}
        r={AMBER_R}
        fill="none"
        stroke="var(--struck)"
        strokeWidth={6}
        strokeLinecap="round"
        pathLength={1}
        strokeDasharray={`${GAP} ${1 - GAP}`}
        strokeDashoffset={-(1 - GAP)}
        transform="rotate(-90 60 60)"
      />
    </motion.svg>
  );
}
