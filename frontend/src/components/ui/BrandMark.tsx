import { motion, useReducedMotion } from 'framer-motion';

/**
 * The chrome-only version of the record's ring, header and footer, not
 * the strike-capable RingMark. Always calm, always breathing (unless
 * reduced motion), it never needs to represent a specific record's
 * standing, so it carries none of RingMark's phase machinery.
 */
export function BrandMark({ className }: { className?: string }) {
  const prefersReduced = useReducedMotion();

  return (
    <motion.svg
      viewBox="0 0 120 120"
      className={['brand-mark', className].filter(Boolean).join(' ')}
      role="img"
      aria-label="Revoca"
      animate={prefersReduced ? undefined : { scale: [1, 1.02, 1], opacity: [0.92, 1, 0.92] }}
      transition={{ duration: 3.8, repeat: Infinity, ease: 'easeInOut' }}
      style={{ transformOrigin: '60px 60px' }}
    >
      <circle cx={60} cy={60} r={42} fill="none" stroke="var(--ink)" strokeWidth={7} strokeLinecap="round" />
    </motion.svg>
  );
}
