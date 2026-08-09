import { motion } from 'framer-motion';

export type FormRingPhase = 'unformed' | 'forming' | 'formed';

const EASE_SNAP = [0.62, 0, 0.32, 1.28] as const;
const EASE_CONFIDENT = [0.16, 1, 0.3, 1] as const;

/** Same gap fraction as RingMark's broken state, deliberately: "no standing yet" and "standing broken" share one visual grammar, an incomplete ring, not two different graphics for the same underlying idea. */
const GAP = 0.15;
const BASE_R = 42;
const AMBER_R = 50;

/**
 * The onboarding page's one bold moment: a standing coming into being.
 * Unformed, it's the same open-ring language RingMark uses for "no
 * standing", faint and thin, quietly breathing, waiting. Forming, the
 * gap actually closes over the real provisioning call (`progress` is
 * driven by real elapsed time against the real backend, not a preset
 * animation), amber tracing the shrinking edge, the site of change,
 * exactly where RingMark's break puts it. Formed, one amber pulse marks
 * the instant standing is granted, then it settles into the same calm
 * ink ring the borrower surface and record view use for a valid
 * standing. Reduced motion: no draw, no pulse, each phase renders its
 * resting state directly.
 */
export function StandingFormRing({
  phase,
  progress,
  prefersReduced,
}: {
  phase: FormRingPhase;
  /** 0-1, real elapsed-time progress through the live provisioning call. Ignored outside `forming`. */
  progress: number;
  prefersReduced: boolean | null;
}) {
  const instant = Boolean(prefersReduced);
  const clampedProgress = Math.min(Math.max(progress, 0), 1);

  const closedFraction = phase === 'formed' ? 1 : phase === 'forming' ? 1 - GAP + GAP * clampedProgress : 1 - GAP;
  const strokeWidth = phase === 'formed' ? 6 : phase === 'forming' ? 3 + 3 * clampedProgress : 3;

  const label = phase === 'formed' ? 'Standing: granted' : phase === 'forming' ? 'Standing: forming' : 'Standing: not yet formed';

  return (
    <motion.svg
      viewBox="0 0 120 120"
      className={`ring-mark form-ring form-ring--${phase}`}
      role="img"
      aria-label={label}
      animate={
        instant
          ? undefined
          : phase === 'formed'
            ? { scale: [1, 1.018, 1], opacity: [0.94, 1, 0.94] }
            : phase === 'unformed'
              ? { opacity: [0.32, 0.44, 0.32] }
              : { opacity: 1 }
      }
      transition={
        phase === 'formed'
          ? { duration: 3.8, repeat: Infinity, ease: 'easeInOut' }
          : phase === 'unformed'
            ? { duration: 4.6, repeat: Infinity, ease: 'easeInOut' }
            : { duration: 0.3, ease: EASE_CONFIDENT }
      }
      style={{ transformOrigin: '60px 60px' }}
    >
      <motion.circle
        cx={60}
        cy={60}
        r={BASE_R}
        fill="none"
        stroke="var(--ink)"
        strokeLinecap="round"
        pathLength={1}
        style={{ rotate: -90, transformOrigin: '60px 60px' }}
        initial={false}
        animate={{ pathLength: closedFraction, strokeWidth }}
        transition={{ duration: instant ? 0 : 0.3, ease: EASE_SNAP }}
      />

      {phase === 'forming' && (
        <motion.circle
          cx={60}
          cy={60}
          r={AMBER_R}
          fill="none"
          stroke="var(--struck)"
          strokeWidth={4}
          strokeLinecap="round"
          pathLength={1}
          style={{ rotate: -90, transformOrigin: '60px 60px', pathOffset: closedFraction }}
          initial={false}
          animate={{ pathLength: Math.max(GAP * (1 - clampedProgress), 0.012), opacity: instant ? 0 : 0.85 }}
          transition={{ duration: instant ? 0 : 0.25, ease: EASE_CONFIDENT }}
        />
      )}

      {phase === 'formed' && !instant && (
        <motion.circle
          cx={60}
          cy={60}
          r={AMBER_R}
          fill="none"
          stroke="var(--struck)"
          strokeWidth={3}
          strokeLinecap="round"
          pathLength={1}
          style={{ rotate: -90, transformOrigin: '60px 60px' }}
          initial={{ opacity: 0.9 }}
          animate={{ opacity: 0, scale: 1.06 }}
          transition={{ duration: 0.9, ease: EASE_CONFIDENT }}
        />
      )}
    </motion.svg>
  );
}
