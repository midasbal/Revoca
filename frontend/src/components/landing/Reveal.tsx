import { motion, useReducedMotion } from 'framer-motion';
import type { ReactNode } from 'react';

const EASE_CONFIDENT = [0.16, 1, 0.3, 1] as const;

/**
 * The narrative's one repeated device: a block fades up from
 * transparency and settles as it enters the viewport, once, never
 * replayed on re-scroll. `delay` staggers a section's narration before
 * its fact line, so the eye reads in the intended order. Reduced motion
 * skips the transform entirely, content is simply present.
 */
export function Reveal({
  children,
  className,
  delay = 0,
  y = 22,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  y?: number;
}) {
  const prefersReduced = useReducedMotion();

  return (
    <motion.div
      className={className}
      initial={prefersReduced ? false : { opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.4, margin: '0px 0px -10% 0px' }}
      transition={{ duration: 0.9, delay, ease: EASE_CONFIDENT }}
    >
      {children}
    </motion.div>
  );
}
