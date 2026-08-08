import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';

export type StrikePhase = 'valid' | 'striking' | 'struck';

/**
 * Shared phase state for the ring and the standing word, so the two stay
 * perfectly in sync without prop-drilling the animation logic through
 * both. `ready` gates everything on real data existing: this hook mounts
 * before the first chain read resolves (it's not conditionally mounted
 * the way the old single-word version was), so without that gate the
 * very first real "struck" value to arrive would get treated as a mount
 * artifact and silently skipped rather than applied. The FIRST ready tick
 * sets the phase directly, matching reality with no animation, a record
 * that loads already struck never plays the break, it only plays for a
 * transition witnessed live after that.
 */
export function useStrikePhase(struck: boolean, ready: boolean) {
  const prefersReduced = useReducedMotion();
  const [phase, setPhase] = useState<StrikePhase>('valid');
  const initialized = useRef(false);

  useEffect(() => {
    if (!ready) return;
    if (!initialized.current) {
      initialized.current = true;
      setPhase(struck ? 'struck' : 'valid');
      return;
    }
    setPhase((current) => {
      if (struck && current === 'valid') return prefersReduced ? 'struck' : 'striking';
      if (!struck && current !== 'valid') return 'valid';
      return current;
    });
  }, [struck, ready, prefersReduced]);

  function completeStrike() {
    setPhase((current) => (current === 'striking' ? 'struck' : current));
  }

  return { phase, prefersReduced, completeStrike };
}
