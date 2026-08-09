import { memo } from 'react';
import { motion } from 'framer-motion';
import type { StrikePhase } from '../hooks/useStrikePhase';
import { usePrevious } from '../hooks/usePrevious';

const EASE_SNAP = [0.62, 0, 0.32, 1.28] as const;
const EASE_CONFIDENT = [0.16, 1, 0.3, 1] as const;

/** Fraction of the ring's circumference the break opens, echoes the gap in revoca-logo.jpeg's mark. */
const GAP = 0.15;
const BASE_R = 42;
const AMBER_R = 50;

/**
 * The seal: a ring that echoes the Revoca mark's broken circle. Valid,
 * it's a closed, calm off-white/ink ring that breathes very subtly,
 * signaling the standing is continuously watched, not a static badge.
 * Struck, the ring itself opens and the brand's amber sweeps in to sever
 * it, exactly where the gap appears, the one orchestrated, decisive
 * moment on the page. Respects prefers-reduced-motion: no breathing, no
 * sweep, the ring simply renders in its resting state for the phase.
 */
export const RingMark = memo(function RingMark({
  phase,
  prefersReduced,
  onStrikeComplete,
}: {
  phase: StrikePhase;
  prefersReduced: boolean | null;
  onStrikeComplete: () => void;
}) {
  const open = phase !== 'valid';
  const label = phase === 'struck' ? 'Standing: struck' : phase === 'striking' ? 'Standing: breaking' : 'Standing: valid';

  // A record that loads (or re-renders) already struck jumps straight from
  // the default 'valid' phase to 'struck', skipping 'striking' entirely,
  // see useStrikePhase. Only animate the break when this render or the
  // last one was actually 'striking', otherwise the open/closed state
  // should just be true from the first frame, no transition, no replay.
  const prevPhase = usePrevious(phase);
  const live = phase === 'striking' || prevPhase === 'striking';
  const instant = Boolean(prefersReduced) || !live;

  return (
    <motion.svg
      viewBox="0 0 120 120"
      className="ring-mark"
      role="img"
      aria-label={label}
      animate={
        prefersReduced
          ? undefined
          : phase === 'valid'
            ? { scale: [1, 1.018, 1], opacity: [0.94, 1, 0.94] }
            : phase === 'striking'
              ? { scale: [1, 0.958, 1.014, 1] }
              : { scale: 1, opacity: 1 }
      }
      transition={
        phase === 'valid'
          ? { duration: 3.8, repeat: Infinity, ease: 'easeInOut' }
          : { duration: 0.4, ease: EASE_SNAP }
      }
      style={{ transformOrigin: '60px 60px' }}
    >
      <motion.circle
        cx={60}
        cy={60}
        r={BASE_R}
        fill="none"
        stroke="var(--ink)"
        strokeWidth={6}
        strokeLinecap="round"
        pathLength={1}
        style={{ rotate: -90, transformOrigin: '60px 60px' }}
        initial={false}
        animate={{ pathLength: open ? 1 - GAP : 1 }}
        transition={{ duration: instant ? 0 : 0.34, ease: EASE_SNAP }}
      />
      <motion.circle
        cx={60}
        cy={60}
        r={AMBER_R}
        fill="none"
        stroke="var(--struck)"
        strokeWidth={5}
        strokeLinecap="round"
        pathLength={1}
        style={{ rotate: -90, transformOrigin: '60px 60px', pathOffset: 1 - GAP }}
        initial={false}
        animate={{ pathLength: open ? GAP : 0, opacity: open ? 1 : 0 }}
        transition={{ duration: instant ? 0 : 0.3, delay: instant ? 0 : 0.08, ease: EASE_CONFIDENT }}
        onAnimationComplete={() => {
          if (phase === 'striking') onStrikeComplete();
        }}
      />
    </motion.svg>
  );
});
