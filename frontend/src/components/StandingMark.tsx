import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';

type Phase = 'valid' | 'striking' | 'struck';

const EASE_CONFIDENT = [0.16, 1, 0.3, 1] as const;

/**
 * The signature element: a record's standing losing validity. Renders
 * "VALID" until `struck` becomes true, at which point a single stroke
 * draws across the word (the strike), then the word itself replaces
 * itself with "STRUCK" in the reserved oxblood ink. Plays once per
 * transition, a page loaded already-struck shows the struck state
 * directly, no replay. Respects prefers-reduced-motion by skipping the
 * stroke and using an instant swap.
 */
export function StandingMark({ struck }: { struck: boolean }) {
  const prefersReduced = useReducedMotion();
  const [phase, setPhase] = useState<Phase>(struck ? 'struck' : 'valid');
  const hasMounted = useRef(false);

  useEffect(() => {
    if (!hasMounted.current) {
      hasMounted.current = true;
      return;
    }
    if (struck && phase === 'valid') {
      setPhase(prefersReduced ? 'struck' : 'striking');
    }
    if (!struck && phase !== 'valid') {
      setPhase('valid');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- phase is intentionally read but not a dependency, this effect only reacts to `struck` flipping
  }, [struck, prefersReduced]);

  const label = phase === 'struck' ? 'STRUCK' : 'VALID';
  const wordClass = phase === 'struck' ? 'standing__word standing__word--struck' : 'standing__word standing__word--valid';

  return (
    <div className="standing__word-wrap">
      <AnimatePresence initial={false}>
        <motion.h1
          key={label}
          className={wordClass}
          initial={phase === 'struck' && !prefersReduced ? { opacity: 0, y: 6 } : false}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.22, ease: EASE_CONFIDENT }}
        >
          {label}
        </motion.h1>
      </AnimatePresence>
      {phase === 'striking' && (
        <motion.span
          className="standing__strike-line"
          initial={{ scaleX: 0 }}
          animate={{ scaleX: 1 }}
          transition={{ duration: 0.5, ease: EASE_CONFIDENT }}
          onAnimationComplete={() => setPhase('struck')}
        />
      )}
    </div>
  );
}
