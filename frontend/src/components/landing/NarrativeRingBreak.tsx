import { motion, useReducedMotion } from 'framer-motion';
import { useState } from 'react';

const EASE_SNAP = [0.62, 0, 0.32, 1.28] as const;
const EASE_CONFIDENT = [0.16, 1, 0.3, 1] as const;
const GAP = 0.15;
const BASE_R = 42;
const AMBER_R = 50;

/**
 * The narrative's one orchestrated moment besides the hero settle, the
 * same ring language as the header mark and the record view's own
 * standing, breaking open once as the reader reaches the section about
 * the break itself. Plays once (whileInView with a local "played" guard
 * so re-scrolling never replays it), reduced motion renders the
 * already-broken resting state directly.
 */
export function NarrativeRingBreak() {
  const prefersReduced = useReducedMotion();
  const [played, setPlayed] = useState(false);
  const open = played || Boolean(prefersReduced);

  return (
    <motion.svg
      viewBox="0 0 120 120"
      className="narrative-ring"
      role="img"
      aria-label="A standing, breaking"
      onViewportEnter={() => setPlayed(true)}
      viewport={{ once: true, amount: 0.6 }}
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
        transition={{ duration: prefersReduced ? 0 : 0.5, ease: EASE_SNAP }}
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
        transition={{ duration: prefersReduced ? 0 : 0.45, delay: prefersReduced ? 0 : 0.14, ease: EASE_CONFIDENT }}
      />
    </motion.svg>
  );
}
