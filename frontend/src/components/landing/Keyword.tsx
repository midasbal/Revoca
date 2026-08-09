import { useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import type { ReactNode } from 'react';

/**
 * Amber marks the words that carry the theme itself: standing granted,
 * standing broken. The same single signal color the ring uses, never
 * decoration. Settles in slightly after the section's own reveal, once.
 * Reduced motion shows the final color immediately, no transition.
 */
export function Keyword({
  children,
  tier = 'primary',
}: {
  children: ReactNode;
  tier?: 'primary' | 'secondary';
}) {
  const prefersReduced = useReducedMotion();
  const [lit, setLit] = useState(Boolean(prefersReduced));

  return (
    <motion.span
      className={`kw kw--${tier}${lit ? ' kw--lit' : ''}`}
      onViewportEnter={() => setLit(true)}
      viewport={{ once: true, amount: 0.9 }}
    >
      {children}
    </motion.span>
  );
}
